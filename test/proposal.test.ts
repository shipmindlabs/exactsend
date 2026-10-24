import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineActionType,
  ProposalError,
  ProposalStore,
  Registry,
  RegistryError,
  type ActionAdapter,
  type ApprovalWindow,
  type Attachment,
  type Proposal,
  type ProposalErrorCode,
  type ProposalInput,
  type Revision,
} from '../src/index.ts';

const encoder = new TextEncoder();
const NOW = 1_700_000_000_000;
const MAX_WINDOW_MS = 60 * 60_000;
const WINDOW: ApprovalWindow = { notBefore: NOW, notAfter: NOW + 15 * 60_000 };

// Renders from the draft alone, so target and attachment order can only reach a
// digest by being digested, not by leaking into the bytes.
function emailAdapter(footer = ''): ActionAdapter {
  return {
    render({ draft }) {
      const lines = [
        'X-Template: invoice/v1',
        `Subject: ${String(draft.subject ?? '')}`,
        '',
        String(draft.body ?? ''),
      ];
      if (footer !== '') {
        lines.push('', footer);
      }
      return encoder.encode(lines.join('\n'));
    },
    send: async () => 'sent',
  } as ActionAdapter;
}

function store(adapter: ActionAdapter = emailAdapter()): ProposalStore {
  return new ProposalStore(
    new Registry([
      defineActionType({
        name: 'email.send',
        reversible: false,
        ttlMs: 10 * 60_000,
        maxWindowMs: MAX_WINDOW_MS,
        approverRoles: ['ops-lead'],
        maxBatch: 5,
        adapter,
      }),
    ]),
    { now: () => NOW },
  );
}

function proposalInput(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    type: 'email.send',
    target: 'ops@example.com',
    draft: { subject: 'Invoice 41', body: 'Attached.' },
    window: WINDOW,
    proposer: 'assistant-7',
    ...overrides,
  };
}

function revisionAt(proposal: Proposal, index: number): Revision {
  const revision = proposal.revisions[index];
  assert.ok(revision);
  return revision;
}

async function digestOf(
  overrides: Partial<ProposalInput> = {},
  footer = '',
): Promise<string> {
  const proposal = await store(emailAdapter(footer)).propose(proposalInput(overrides));
  return revisionAt(proposal, 0).digest;
}

function refuses(code: ProposalErrorCode, run: () => Promise<unknown>): Promise<void> {
  return assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ProposalError);
    assert.equal(error.code, code);
    return true;
  });
}

const first: Attachment = { filename: 'invoice-41.pdf', bytes: encoder.encode('alpha') };
const second: Attachment = { filename: 'terms.pdf', bytes: encoder.encode('beta') };

test('a proposal stores the rendered wire bytes as revision 1', async () => {
  const proposal = await store().propose(proposalInput());
  const revision = revisionAt(proposal, 0);

  assert.equal(proposal.revisions.length, 1);
  assert.equal(revision.number, 1);
  assert.equal(revision.reason, 'proposed');
  assert.match(revision.digest, /^[0-9a-f]{64}$/);
  assert.match(revision.payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    new TextDecoder().decode(revision.payload),
    'X-Template: invoice/v1\nSubject: Invoice 41\n\nAttached.',
  );
  assert.deepEqual(revision.window, WINDOW);
  assert.equal(revision.createdAt, NOW);
});

test('a footer added by render changes the digest', async () => {
  const plain = await digestOf();
  const footered = await digestOf({}, 'Unsubscribe: https://example.com/u/41');
  assert.notEqual(plain, footered);
});

test('the same draft twice gives the same digest', async () => {
  assert.equal(await digestOf(), await digestOf());
});

test('swapping two attachments changes the digest', async () => {
  const ordered = await digestOf({ attachments: [first, second] });
  const swapped = await digestOf({ attachments: [second, first] });
  assert.notEqual(ordered, swapped);
});

test('attachments describe themselves by content', async () => {
  const proposal = await store().propose(proposalInput({ attachments: [first] }));
  const record = revisionAt(proposal, 0).attachments[0];
  assert.ok(record);
  assert.equal(record.filename, 'invoice-41.pdf');
  assert.equal(record.byteLength, 5);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
});

test('the target is part of the digest', async () => {
  const ops = await digestOf();
  const finance = await digestOf({ target: 'finance@example.com' });
  assert.notEqual(ops, finance);
});

test('the window is part of the digest', async () => {
  const short = await digestOf();
  const long = await digestOf({ window: { notBefore: NOW, notAfter: NOW + 16 * 60_000 } });
  assert.notEqual(short, long);
});

test('an edit appends a revision and leaves the first one as it was', async () => {
  const proposals = store();
  const proposed = await proposals.propose(proposalInput());
  const original = revisionAt(proposed, 0);

  const edited = await proposals.edit(proposed.id, {
    subject: 'Invoice 41',
    body: 'Corrected total.',
  });
  const revision = revisionAt(edited, 1);

  assert.equal(edited.revisions.length, 2);
  assert.equal(revision.number, 2);
  assert.equal(revision.reason, 'edited');
  assert.notEqual(revision.digest, original.digest);
  assert.notEqual(revision.payloadSha256, original.payloadSha256);
  assert.deepEqual(revision.window, original.window);
  assert.deepEqual(revisionAt(edited, 0), original);
  assert.deepEqual(revisionAt(proposals.get(proposed.id), 0), original);
});

test('a reschedule appends a revision with a new digest over the same bytes', async () => {
  const proposals = store();
  const proposed = await proposals.propose(proposalInput());
  const original = revisionAt(proposed, 0);

  const rescheduled = await proposals.reschedule(proposed.id, {
    notBefore: NOW + 60_000,
    notAfter: NOW + 20 * 60_000,
  });
  const revision = revisionAt(rescheduled, 1);

  assert.equal(revision.reason, 'rescheduled');
  assert.notEqual(revision.digest, original.digest);
  assert.equal(revision.payloadSha256, original.payloadSha256);
  assert.deepEqual(revision.draft, original.draft);
  assert.deepEqual(revisionAt(rescheduled, 0), original);
  assert.equal(proposals.latestRevision(proposed.id).number, 2);
});

test('a reschedule wider than the type allows is refused', async () => {
  const proposals = store();
  const proposed = await proposals.propose(proposalInput());
  await refuses('window-too-wide', () =>
    proposals.reschedule(proposed.id, {
      notBefore: NOW,
      notAfter: NOW + MAX_WINDOW_MS + 1,
    }),
  );
  assert.equal(proposals.get(proposed.id).revisions.length, 1);
});

const refusals: Array<{
  label: string;
  code: ProposalErrorCode;
  patch: Partial<ProposalInput>;
}> = [
  {
    label: 'a window wider than the type allows',
    code: 'window-too-wide',
    patch: { window: { notBefore: NOW, notAfter: NOW + MAX_WINDOW_MS + 1 } },
  },
  {
    label: 'a window that ends when it starts',
    code: 'invalid-window',
    patch: { window: { notBefore: NOW, notAfter: NOW } },
  },
  {
    label: 'a window with a fractional bound',
    code: 'invalid-window',
    patch: { window: { notBefore: NOW, notAfter: NOW + 0.5 } },
  },
  {
    label: 'a window carrying an extra key',
    code: 'invalid-window',
    patch: {
      window: { notBefore: NOW, notAfter: NOW + 1000, ttlMs: 10 } as unknown as ApprovalWindow,
    },
  },
  { label: 'an empty target', code: 'invalid-target', patch: { target: '' } },
  { label: 'an empty proposer', code: 'invalid-proposer', patch: { proposer: '' } },
  {
    label: 'a draft that is not a plain object',
    code: 'invalid-draft',
    patch: { draft: [] as unknown as Record<string, unknown> },
  },
  {
    label: 'an attachment without bytes',
    code: 'invalid-attachment',
    patch: { attachments: [{ filename: 'invoice-41.pdf' } as unknown as Attachment] },
  },
  {
    label: 'an attachment without a filename',
    code: 'invalid-attachment',
    patch: { attachments: [{ bytes: encoder.encode('alpha') } as unknown as Attachment] },
  },
];

for (const { label, code, patch } of refusals) {
  test(`refuses ${label} with code ${code}`, async () => {
    await refuses(code, () => store().propose(proposalInput(patch)));
  });
}

test('an unregistered type has no adapter to render with', async () => {
  await assert.rejects(
    () => store().propose(proposalInput({ type: 'email.sned' })),
    (error: unknown) => {
      assert.ok(error instanceof RegistryError);
      assert.equal(error.code, 'unknown-action-type');
      return true;
    },
  );
});

test('an unknown proposal id cannot be edited', async () => {
  await refuses('unknown-proposal', () => store().edit('missing', { body: 'x' }));
});

test('an adapter that cannot render refuses the proposal', async () => {
  const sendOnly = { send: async () => 'sent' } as unknown as ActionAdapter;
  await refuses('adapter-cannot-render', () => store(sendOnly).propose(proposalInput()));
});

test('an adapter rendering something other than bytes is refused', async () => {
  const broken = {
    render: () => 'Subject: Invoice 41',
    send: async () => 'sent',
  } as unknown as ActionAdapter;
  await refuses('invalid-payload', () => store(broken).propose(proposalInput()));
});
