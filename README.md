# exactsend

Human approval for an AI assistant's outbound actions that binds to the exact bytes sent to the
provider: single-use, time-limited approvals from someone other than the proposer, and
reconciliation with the provider before any retry.

An approval is only worth something if it names precisely what was approved. So the first piece is
the naming: a canonical encoding of a proposed action, and a SHA-256 digest over those bytes. The
rest of the flow refers to that digest.

## Status

This phase ships the action digest, the action type registry and proposals that hold the rendered
wire bytes. Approvals, expiry, the second-human rule and provider reconciliation are not
implemented yet.

## Usage

```ts
import { actionDigest, canonicalBytes, CanonicalError } from 'exactsend';

const action = { to: 'ops@example.com', subject: 'Invoice 41', minorUnits: 1200 };

const digest = await actionDigest(action); // 64 lowercase hex characters
const bytes = canonicalBytes(action); // what the digest was taken over

try {
  await actionDigest({ amount: 12.5 });
} catch (error) {
  if (error instanceof CanonicalError) {
    console.error(error.code, error.path); // NON_INTEGER_NUMBER $.amount
  }
}
```

## The encoding

- Every encoding starts with the domain label `exactsend/v1\n`, so a digest from this scheme cannot
  be replayed as a digest from another one.
- Object keys are sorted by UTF-16 code units, so key order never changes a digest.
- Strings are encoded as exact UTF-8 with no Unicode normalization. `caf\u00e9` and `cafe\u0301`
  look alike and digest differently, because they are different bytes on the wire.
- Numbers are safe integers only. Pass money as minor units or as a string.
- Every value is tagged and length-prefixed, so no two different inputs can produce the same byte
  stream by shifting a boundary.

## What it refuses

Refusals throw `CanonicalError` with a `code` and the `path` of the offending value.

| code | refused value |
| --- | --- |
| `NON_INTEGER_NUMBER` | `12.5`, `NaN`, `Infinity` |
| `UNSAFE_INTEGER` | integers beyond `2^53 - 1` |
| `UNDEFINED` | `undefined`, including as a property value |
| `FUNCTION` | functions |
| `SYMBOL` | symbols |
| `BIGINT` | `1n` |
| `DATE` | `Date` |
| `MAP` / `SET` | `Map`, `Set` |
| `CLASS_INSTANCE` | anything that is not a plain object or array |
| `LONE_SURROGATE` | strings with an unpaired surrogate |
| `CIRCULAR_REFERENCE` | a value that contains itself |

The lone surrogate case is the subtle one: `TextEncoder` silently turns an unpaired surrogate into
U+FFFD, so two different strings would otherwise share a digest.

## Action types

An action type exists because code registers it, never because configuration mentions it.

```ts
import { defineActionType, Registry } from 'exactsend';

const emailSend = defineActionType({
  name: 'email.send',
  reversible: false,
  ttlMs: 10 * 60_000,
  maxWindowMs: 60 * 60_000,
  approverRoles: ['ops-lead', 'finance'],
  maxBatch: 5,
  adapter: emailAdapter,
});

const registry = new Registry([emailSend]);
```

Every registered type requires approval. `reversible` says only whether a sent action can be taken
back, which later phases use to decide how hard reconciliation has to work.

A name nobody registered has no policy to read, so it reads as its own worst case, and there is no
adapter to run it with:

```ts
registry.policyFor('email.sned');
// { registered: false, reversible: false, approvalRequired: true, executable: false, ... }

registry.adapterFor('email.sned'); // RegistryError: unknown-action-type
```

### Overrides may only tighten

`applyPolicyOverrides` takes parsed JSON against a closed schema — `ttlMs`, `approverRoles` and
`maxBatch` per registered type — and returns a new registry. Nothing else is accepted, so
configuration can never name a command, a module or a path:

```ts
const tightened = registry.applyPolicyOverrides({
  'email.send': { ttlMs: 60_000, approverRoles: ['finance'], maxBatch: 2 },
});
```

A longer TTL, an added role, a larger batch or a `reversible` flag are refused rather than applied.

### Registry refusals

Refusals throw `RegistryError` with a `code` and the `path` of the offending value.

| code | refused |
| --- | --- |
| `duplicate-action-type` | two definitions registering the same name |
| `invalid-action-type` | a definition whose own fields do not hold together |
| `unknown-action-type` | resolving an adapter for a name no code registers |
| `invalid-overrides` | overrides that are not a JSON object of type names |
| `unknown-override-type` | an override for a name that is not registered |
| `unknown-override-key` | any key outside `ttlMs`, `approverRoles`, `maxBatch` |
| `reversible-not-overridable` | a `reversible` flag in configuration |
| `invalid-override-value` | a value of the wrong type or outside its range |
| `ttl-not-tightened` | a TTL longer than the registered one |
| `role-not-registered` | an approver role the code never registered |
| `batch-not-tightened` | a batch larger than the registered one |

## Proposals

A proposal is a rendered action, not a draft. `propose` asks the type's adapter to render the final
bytes the provider will receive — template, signature, unsubscribe footer, rewritten links — and
stores them as revision 1. An adapter therefore implements `render(request)` next to `send(action)`.

```ts
import { ProposalStore } from 'exactsend';

const proposals = new ProposalStore(registry);

const proposal = await proposals.propose({
  type: 'email.send',
  target: 'ops@example.com',
  draft: { subject: 'Invoice 41', body: 'Attached.' },
  attachments: [{ filename: 'invoice-41.pdf', bytes: pdf }],
  window: { notBefore: Date.now(), notAfter: Date.now() + 15 * 60_000 },
  proposer: 'assistant-7',
});

const [revision] = proposal.revisions;
revision.payload; // the exact bytes that will go out
revision.digest; // what an approver will be approving
```

The digest covers the type, the target, the SHA-256 of the payload bytes, the attachment SHA-256
values in their order, and the window `{ notBefore, notAfter }`. It does not cover the draft: a
footer the adapter adds is part of what gets approved, and two renders of the same draft digest the
same. A window wider than the type's `maxWindowMs` is refused rather than clamped.

`edit(proposalId, draft)` and `reschedule(proposalId, window)` re-render and append revision n+1
with its own digest. An earlier revision is never mutated, so an approval of revision 1 can never be
read as an approval of revision 2.

### Proposal refusals

Refusals throw `ProposalError` with a `code` and the `path` of the offending value.

| code | refused |
| --- | --- |
| `unknown-proposal` | an id no proposal has |
| `invalid-target` | a target that is not a non-empty string |
| `invalid-proposer` | a proposer that is not a non-empty string |
| `invalid-draft` | a draft that is not a plain object |
| `invalid-attachment` | an attachment without a filename or without `Uint8Array` bytes |
| `invalid-window` | a window outside `{ notBefore, notAfter }`, out of order, or not epoch milliseconds |
| `window-too-wide` | a window wider than the type's `maxWindowMs` |
| `adapter-cannot-render` | an adapter with no `render`, so there are no bytes to approve |
| `invalid-payload` | a `render` that returns something other than `Uint8Array` |

## Development

Requires Node >= 22.18, which runs the TypeScript sources directly. There are no runtime
dependencies.

```sh
npm install
npm test
npm run typecheck
```

---

Maintained by [Shipmind Labs](https://shipmindlabs.com).
