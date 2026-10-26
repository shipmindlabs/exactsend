import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApprovalDesk,
  ApprovalError,
  defineActionType,
  ProposalError,
  ProposalStore,
  Registry,
  type ActionAdapter,
  type ApprovalErrorCode,
  type Principal,
  type ProposalInput,
  type RenderRequest,
} from '../src/index.ts';

const encoder = new TextEncoder();
const PROPOSED_AT = 1_700_000_000_000;
const DECIDED_AT = PROPOSED_AT + 2 * 60_000;
const TTL_MS = 10 * 60_000;

const adapter = {
  render: ({ draft }: RenderRequest) =>
    encoder.encode(`Subject: ${String(draft.subject ?? '')}`),
  send: async () => 'sent',
} as unknown as ActionAdapter;

const opsLead: Principal = { id: 'dana', kind: 'human', roles: ['ops-lead'] };

function harness(): { proposals: ProposalStore; desk: ApprovalDesk } {
  const registry = new Registry([
    defineActionType({
      name: 'email.send',
      reversible: false,
      ttlMs: TTL_MS,
      maxWindowMs: 60 * 60_000,
      approverRoles: ['ops-lead', 'finance'],
      maxBatch: 5,
      adapter,
    }),
  ]);
  const proposals = new ProposalStore(registry, { now: () => PROPOSED_AT });
  return {
    proposals,
    desk: new ApprovalDesk(registry, proposals, { now: () => DECIDED_AT }),
  };
}

function proposalInput(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    type: 'email.send',
    target: 'ops@example.com',
    draft: { subject: 'Invoice 41' },
    window: { notBefore: PROPOSED_AT, notAfter: PROPOSED_AT + 15 * 60_000 },
    proposer: 'assistant-7',
    ...overrides,
  };
}

function refuses(code: ApprovalErrorCode, run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ApprovalError);
    assert.equal(error.code, code);
    return true;
  });
}

test('an approval records who decided, what they saw and when it expires', async () => {
  const { proposals, desk } = harness();
  const proposal = await proposals.propose(proposalInput());
  const revision = proposals.latestRevision(proposal.id);

  const approval = desk.approve({
    proposalId: proposal.id,
    revision: revision.number,
    digest: revision.digest,
    approver: opsLead,
  });

  assert.equal(approval.proposalId, proposal.id);
  assert.equal(approval.revision, 1);
  assert.equal(approval.approver, 'dana');
  assert.equal(approval.digest, revision.digest);
  assert.equal(approval.decidedAt, DECIDED_AT);
  assert.equal(approval.expiresAt, DECIDED_AT + TTL_MS);
});

test('an agent approver is refused even holding an allowed role', async () => {
  const { proposals, desk } = harness();
  const proposal = await proposals.propose(proposalInput());
  const revision = proposals.latestRevision(proposal.id);

  refuses('agent-approver', () =>
    desk.approve({
      proposalId: proposal.id,
      revision: revision.number,
      digest: revision.digest,
      approver: { id: 'reviewer-bot', kind: 'agent', roles: ['ops-lead'] },
    }),
  );
});

test('an agent that is also the proposer is refused as an agent first', async () => {
  const { proposals, desk } = harness();
  const proposal = await proposals.propose(proposalInput());
  const revision = proposals.latestRevision(proposal.id);

  refuses('agent-approver', () =>
    desk.approve({
      proposalId: proposal.id,
      revision: revision.number,
      digest: revision.digest,
      approver: { id: 'assistant-7', kind: 'agent', roles: ['ops-lead'] },
    }),
  );
});

test('the proposer cannot approve their own proposal', async () => {
  const { proposals, desk } = harness();
  const proposal = await proposals.propose(proposalInput({ proposer: 'dana' }));
  const revision = proposals.latestRevision(proposal.id);

  refuses('self-approval', () =>
    desk.approve({
      proposalId: proposal.id,
      revision: revision.number,
      digest: revision.digest,
      approver: opsLead,
    }),
  );
});

test('an approver outside the allowed roles is refused', async () => {
  const { proposals, desk } = harness();
  const proposal = await proposals.propose(proposalInput());
  const revision = proposals.latestRevision(proposal.id);

  refuses('role-not-allowed', () =>
    desk.approve({
      proposalId: proposal.id,
      revision: revision.number,
      digest: revision.digest,
      approver: { id: 'dana', kind: 'human', roles: ['legal'] },
    }),
  );
  refuses('role-not-allowed', () =>
    desk.approve({
      proposalId: proposal.id,
      revision: revision.number,
      digest: revision.digest,
      approver: { id: 'dana', kind: 'human', roles: [] },
    }),
  );
});

test('a digest from an earlier revision does not approve the current one', async () => {
  const { proposals, desk } = harness();
  const proposal = await proposals.propose(proposalInput());
  const stale = proposals.latestRevision(proposal.id).digest;
  await proposals.edit(proposal.id, { subject: 'Invoice 42' });

  refuses('stale-digest', () =>
    desk.approve({ proposalId: proposal.id, revision: 2, digest: stale, approver: opsLead }),
  );

  const current = proposals.latestRevision(proposal.id);
  const approval = desk.approve({
    proposalId: proposal.id,
    revision: 2,
    digest: current.digest,
    approver: opsLead,
  });
  assert.equal(approval.revision, 2);
  assert.equal(approval.digest, current.digest);
});

test('a digest of no revision at all is refused', async () => {
  const { proposals, desk } = harness();
  const proposal = await proposals.propose(proposalInput());

  refuses('stale-digest', () =>
    desk.approve({
      proposalId: proposal.id,
      revision: 1,
      digest: '0'.repeat(64),
      approver: opsLead,
    }),
  );
});

test('a revision number the proposal does not have is refused', async () => {
  const { proposals, desk } = harness();
  const proposal = await proposals.propose(proposalInput());
  const revision = proposals.latestRevision(proposal.id);

  refuses('unknown-revision', () =>
    desk.approve({
      proposalId: proposal.id,
      revision: 2,
      digest: revision.digest,
      approver: opsLead,
    }),
  );
});

test('an unknown proposal id has nothing to approve', () => {
  const { desk } = harness();
  assert.throws(
    () =>
      desk.approve({
        proposalId: 'missing',
        revision: 1,
        digest: '0'.repeat(64),
        approver: opsLead,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProposalError);
      assert.equal(error.code, 'unknown-proposal');
      return true;
    },
  );
});

const invalidApprovers: Array<{ label: string; value: unknown }> = [
  { label: 'an approver that is not an object', value: 'dana' },
  { label: 'an approver without an id', value: { kind: 'human', roles: ['ops-lead'] } },
  {
    label: 'an approver with an unknown kind',
    value: { id: 'dana', kind: 'service', roles: ['ops-lead'] },
  },
  {
    label: 'an approver whose roles are not an array',
    value: { id: 'dana', kind: 'human', roles: 'ops-lead' },
  },
  {
    label: 'an approver with a role that is not a string',
    value: { id: 'dana', kind: 'human', roles: [3] },
  },
];

for (const { label, value } of invalidApprovers) {
  test(`refuses ${label} with code invalid-approver`, async () => {
    const { proposals, desk } = harness();
    const proposal = await proposals.propose(proposalInput());
    const revision = proposals.latestRevision(proposal.id);

    refuses('invalid-approver', () =>
      desk.approve({
        proposalId: proposal.id,
        revision: revision.number,
        digest: revision.digest,
        approver: value as Principal,
      }),
    );
  });
}

test('a tightened ttl shortens the approval', async () => {
  const registry = new Registry([
    defineActionType({
      name: 'email.send',
      reversible: false,
      ttlMs: TTL_MS,
      maxWindowMs: 60 * 60_000,
      approverRoles: ['ops-lead', 'finance'],
      maxBatch: 5,
      adapter,
    }),
  ]).applyPolicyOverrides({ 'email.send': { ttlMs: 60_000 } });
  const proposals = new ProposalStore(registry, { now: () => PROPOSED_AT });
  const desk = new ApprovalDesk(registry, proposals, { now: () => DECIDED_AT });

  const proposal = await proposals.propose(proposalInput());
  const revision = proposals.latestRevision(proposal.id);
  const approval = desk.approve({
    proposalId: proposal.id,
    revision: revision.number,
    digest: revision.digest,
    approver: opsLead,
  });

  assert.equal(approval.expiresAt, DECIDED_AT + 60_000);
});
