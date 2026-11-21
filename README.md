# exactsend

Human approval for an AI assistant's outbound actions that binds to the exact bytes sent to the
provider: single-use, time-limited approvals from someone other than the proposer, and
reconciliation with the provider before any retry.

An approval is only worth something if it names precisely what was approved. So the first piece is
the naming: a canonical encoding of a proposed action, and a SHA-256 digest over those bytes. The
rest of the flow refers to that digest.

## Status

This phase ships the action digest, the action type registry, proposals that hold the rendered wire
bytes, the approval decision itself, the adapters that render and send, single-use consumption at
execution time, in memory or on `node:sqlite`, and reconciliation with the provider before any
retry.

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

## Adapters

An adapter owns both halves of one action type: it renders the bytes the provider will receive, and
it sends exactly those bytes.

```ts
import { actionAdapter, emailAdapter, FakeEmailProvider } from 'exactsend';

const provider = new FakeEmailProvider();
const adapter = actionAdapter(emailAdapter({ provider }));
// ... then defineActionType({ name: 'email.send', adapter, ... })
```

`Adapter` is the shape you write: `render(draft, target)`, `send(bytes, { executionKey })`, a
`honoursIdempotencyKey` claim and an optional `queryStatus(executionKey)`. `actionAdapter` turns it
into what the registry takes, so an adapter never has to know about revisions or approvals — it is
handed the approved bytes and the key to send them under.

`honoursIdempotencyKey` is a claim about the provider, not about the header: sending an
`Idempotency-Key` is not the same as the endpoint deduplicating on it, so the claim belongs to
whoever knows the endpoint. Reconciliation reads it to decide whether a retry under the same
execution key is safe or has to be asked about first. `queryStatus` answers `sent`, `not-sent` or
`unknown`, and `unknown` is an honest answer a provider is allowed to give.

`emailAdapter({ provider, template })` renders a template to UTF-8 bytes and delivers them with the
execution key as the provider's idempotency key. `FakeEmailProvider` is that provider in memory: it
keeps every delivery for a test to read, and answers a repeated key with the reference it already
gave instead of delivering twice.

`WebhookAdapter` is the generic one. It renders `{ target, draft }` as JSON with sorted keys, so two
drafts differing only in key order render the same bytes and digest the same, and POSTs those bytes
with `Content-Type: application/json` and `Idempotency-Key: <executionKey>` through an injected
`fetch`. A response that is not `ok` throws, which the executor records as a failed execution.

```ts
import { WebhookAdapter } from 'exactsend';

const hook = actionAdapter(
  new WebhookAdapter({
    url: 'https://example.com/hooks/send',
    fetch: post, // (url, { method, headers, body }) => { ok, status, text() }
    honoursIdempotencyKey: true,
  }),
);
```

Only email and webhooks ship here. A platform with its own approval semantics needs its own
adapter, written where that platform is understood.

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

## Approvals

An approval is a decision by a human other than the proposer, holding a role the action type
allows, over the digest of one revision.

```ts
import { ApprovalDesk } from 'exactsend';

const desk = new ApprovalDesk(registry, proposals);
const revision = proposals.latestRevision(proposal.id);

const approval = desk.approve({
  proposalId: proposal.id,
  revision: revision.number,
  digest: revision.digest,
  approver: { id: 'dana', kind: 'human', roles: ['ops-lead'] },
});

approval.approver; // 'dana'
approval.decidedAt; // read from the clock the desk was built with
approval.expiresAt; // decidedAt + the type's ttlMs
```

The submitted digest has to be the digest of that revision, so a reviewer approves what they saw: a
digest from revision 1 does not approve revision 2, and an edit that lands between reading and
deciding is refused instead of being carried over.

An approver whose kind is `agent` is refused, and no option relaxes that. The proposer cannot
approve their own proposal even while holding an allowed role. A desk takes its clock as
`new ApprovalDesk(registry, proposals, { now })`, so expiry is testable.

### Approval refusals

Refusals throw `ApprovalError` with a `code` and the `path` of the offending value.

| code | refused |
| --- | --- |
| `invalid-approver` | an approver without an id, a known kind or a list of roles |
| `unknown-revision` | a revision number this proposal does not have |
| `agent-approver` | an approver whose kind is `agent` |
| `self-approval` | an approver whose id is the proposer |
| `role-not-allowed` | an approver holding none of the type's `approverRoles` |
| `stale-digest` | a digest that is not the digest of that revision |

## Execution

An approval buys one send. `execute(approvalId)` reads the recorded approval, checks that it has not
expired and that the clock is inside the approved revision's window, and only then consumes it.

Before consuming, it has the adapter render the stored draft again. A template, footer or link
rewrite that moved since the decision renders to another digest, and that digest was never
approved, so `execute` refuses `render-drift`, the provider is never called and the approval stays
unspent. When the render still reproduces the approved digest, the bytes stored with the revision go
out — not the ones just rendered, which are the same bytes only as long as nothing drifted.

`ApprovalStore.consumeAndRecordIntent(approvalId, executionKey, now)` is the single step that makes
the send legitimate: it marks the approval consumed only where it was not already consumed, and
writes an execution row in state `dispatching` with it. If no row changed, the approval was already
spent, so `execute` refuses `already-consumed` and the provider is never called. Two concurrent
calls on one approval therefore give one send and one refusal.

```ts
import { Executor, MemoryApprovalStore } from 'exactsend';

const store = new MemoryApprovalStore();
const { approvalId } = await store.recordApproval(approval);

const executor = new Executor(registry, proposals, store);
const execution = await executor.execute(approvalId);

execution.executionKey; // the key the provider call carried, stable for reconciliation
execution.state; // 'sent', 'failed' or 'unknown'
execution.providerRef; // whatever the adapter returned to name the send
```

The adapter's `send` receives the approved bytes, their digest and the `executionKey`, so a provider
that accepts an idempotency key can be given one.

The send itself is not atomic with the store. The provider call happens after that commit, and its
result is written as a second step, so a crash in between leaves a row in `dispatching` — the honest
state, because the bytes may or may not be on the wire and only reconciliation with the provider can
tell. A provider error is recorded as `failed` for the same reason instead of being thrown back as
something to retry: the approval stays consumed.

### The execution key

The execution key is not drawn at random. It is the hex SHA-256 of `exactsend/exec/v1\n` followed by
the approval id, so an execution that crashed between the commit and the result reuses exactly the
key the provider already saw, and two approvals can never share one:

```ts
import { executionKeyFor } from 'exactsend';

await executionKeyFor(approvalId); // 64 lowercase hex characters, the same on every attempt
```

Because consumption is read before the key, a second `execute` on one approval reads as
`already-consumed` rather than as a clash with its own first attempt.

### A timeout is unknown, not failed

A provider that refuses said something: nothing landed. A provider that ran out of time said
nothing at all, so the bytes may already be on its side. Those are different facts, and the
execution row keeps them apart.

An adapter reports the second one by throwing `SendTimeoutError`. A `TimeoutError`, an `AbortError`
and the usual socket codes (`ETIMEDOUT`, `UND_ERR_HEADERS_TIMEOUT` and friends) are read the same
way. It is recognised by shape, never by wording: an ordinary `Error` whose message happens to
mention a timeout is a failure like any other, because nothing about it says the bytes might have
landed.

| state | what it means |
| --- | --- |
| `dispatching` | the row is committed and the provider call has not come back |
| `sent` | the provider answered, and `providerRef` names the send |
| `failed` | the provider refused, so nothing is on its side |
| `unknown` | the call ran out of time, so the bytes may or may not have landed |
| `delivered` | an `unknown` a status query later confirmed |
| `parked` | an `unknown` nothing but a human can resolve; `blocker` is `needs-human` |

`settledAt` stays null for `dispatching`, `unknown` and `parked`: the execution is still open.

### Reconciliation before any retry

`resume(executionKey)` finishes an execution the provider never answered for. A resend is only one
of the three ways out, and never the first thing tried unless the provider deduplicates:

```ts
const unknown = await executor.execute(approvalId); // state 'unknown', settledAt null
const resolved = await executor.resume(unknown.executionKey);
```

- An adapter that claims `honoursIdempotencyKey` is resent under the same execution key. The
  provider recognises the key and answers with the reference it already gave, so a delivery that
  landed is not repeated.
- Otherwise the provider is asked first. `sent` records `delivered` with the reference it names and
  sends nothing. `unknown` parks the row, because a resend could be a second delivery. `not-sent` is
  the only definite answer that lets the approved bytes go out again.
- An adapter with neither capability parks the row straight away: there is no way to tell, and
  guessing is a duplicate send or a lost one.

A `queryStatus` that cannot be reached refuses with `status-unavailable` and leaves the row
`unknown`, so it can be asked again later. Nothing was learned, so nothing is written.

A parked row carries `blocker: 'needs-human'` and the original timeout message alongside the reason
it was parked. It is settled as far as `resume` is concerned: asking again refuses `not-resumable`,
which is also what a `sent`, `failed` or `delivered` row answers.

### Stores

`ApprovalStore` is a port with two implementations, and one contract suite holds both to the same
behaviour. `MemoryApprovalStore` keeps everything in process. `SqliteApprovalStore` persists through
the built-in `node:sqlite` module, so durability costs no runtime dependency:

```ts
import { Executor, SqliteApprovalStore } from 'exactsend';

const store = new SqliteApprovalStore('approvals.db'); // ':memory:' when no path is given
// ... same Executor, same contract
store.close();
```

A numbered migration creates `proposals`, `revisions`, `approvals`, `executions` and `blockers`, and
records itself in a `migrations` table, so reopening a file applies nothing twice. This phase writes
approvals and executions only; the other tables are there for the proposals that later phases
persist.

Consumption is one `BEGIN IMMEDIATE` transaction: the `UPDATE` that marks the approval consumed has
to change exactly one row, the execution row is inserted with it, and any error rolls the whole
transaction back. Taking the write lock before the first read is what makes check-then-write safe
across connections, so two processes on one database file still get one send and one
`already-consumed`.

### Execution refusals

Refusals throw `ExecuteError` with a `code` and the `path` of the offending value.

| code | refused |
| --- | --- |
| `approval-expired` | an approval whose `expiresAt` has passed |
| `outside-window` | a clock outside the approved revision's window |
| `render-drift` | a draft that no longer renders to the approved digest |
| `already-consumed` | an approval an execution already spent |
| `unknown-revision` | an approval naming a revision the proposal does not hold |
| `not-resumable` | an execution that is settled or parked, so nothing is left to resolve |
| `status-unavailable` | a provider that could not be asked, leaving the row `unknown` |

The store refuses with `StoreError`: `unknown-approval` for an id it does not hold,
`unknown-execution` for an unknown execution key, and `duplicate-execution-key` for a key it has
already written.

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
