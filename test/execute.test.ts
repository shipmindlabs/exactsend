import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApprovalDesk,
  defineActionType,
  ExecuteError,
  Executor,
  MemoryApprovalStore,
  ProposalStore,
  Registry,
  StoreError,
  type ActionAdapter,
  type ApprovalRecord,
  type ApprovalWindow,
  type ExecutionRecord,
  type Principal,
  type RenderRequest,
} from '../src/index.ts';

const encoder = new TextEncoder();
const PROPOSED_AT = 1_700_000_000_000;
const DECIDED_AT = PROPOSED_AT + 2 * 60_000;
const EXECUTE_AT = PROPOSED_AT + 3 * 60_000;
const TTL_MS = 10 * 60_000;
const EXPIRES_AT = DECIDED_AT + TTL_MS;
const WINDOW: ApprovalWindow = { notBefore: PROPOSED_AT, notAfter: PROPOSED_AT + 15 * 60_000 };

const opsLead: Principal = { id: 'dana', kind: 'human', roles: ['ops-lead'] };

interface HarnessOptions {
  readonly executeAt?: number;
  readonly window?: ApprovalWindow;
  readonly send?: (action: Record<string, unknown>) => Promise<unknown>;
}

interface Harness {
  readonly store: MemoryApprovalStore;
  readonly executor: Executor;
  readonly sends: Array<Record<string, unknown>>;
  readonly approval: ApprovalRecord;
  readonly digest: string;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const sends: Array<Record<string, unknown>> = [];
  const adapter = {
    render: ({ draft }: RenderRequest) =>
      encoder.encode(`Subject: ${String(draft.subject ?? '')}`),
    send: async (action: Record<string, unknown>) => {
      sends.push(action);
      return options.send === undefined ? 'provider-ref-1' : await options.send(action);
    },
  } as unknown as ActionAdapter;

  const registry = new Registry([
    defineActionType({
      name: 'email.send',
      reversible: false,
      ttlMs: TTL_MS,
      maxWindowMs: 60 * 60_000,
      approverRoles: ['ops-lead'],
      maxBatch: 5,
      adapter,
    }),
  ]);
  const proposals = new ProposalStore(registry, { now: () => PROPOSED_AT });
  const desk = new ApprovalDesk(registry, proposals, { now: () => DECIDED_AT });
  const store = new MemoryApprovalStore();
  const executeAt = options.executeAt ?? EXECUTE_AT;
  const executor = new Executor(registry, proposals, store, { now: () => executeAt });

  const proposal = await proposals.propose({
    type: 'email.send',
    target: 'ops@example.com',
    draft: { subject: 'Invoice 41' },
    window: options.window ?? WINDOW,
    proposer: 'assistant-7',
  });
  const revision = proposals.latestRevision(proposal.id);
  const approval = await store.recordApproval(
    desk.approve({
      proposalId: proposal.id,
      revision: revision.number,
      digest: revision.digest,
      approver: opsLead,
    }),
  );

  return { store, executor, sends, approval, digest: revision.digest };
}

test('an approval is consumed once and the send is recorded as a second step', async () => {
  const { store, executor, sends, approval, digest } = await harness();

  const execution = await executor.execute(approval.approvalId);

  assert.equal(execution.approvalId, approval.approvalId);
  assert.equal(execution.digest, digest);
  assert.equal(execution.state, 'sent');
  assert.equal(execution.startedAt, EXECUTE_AT);
  assert.equal(execution.settledAt, EXECUTE_AT);
  assert.equal(execution.providerRef, 'provider-ref-1');
  assert.equal(execution.failure, null);

  const consumed = await store.getApproval(approval.approvalId);
  assert.equal(consumed.consumedAt, EXECUTE_AT);
  assert.equal(consumed.executionKey, execution.executionKey);

  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.digest, digest);
  assert.equal(sends[0]?.executionKey, execution.executionKey);
  assert.deepEqual(await store.executionsFor(approval.approvalId), [execution]);
});

test('the dispatching row is committed before the provider is called', async () => {
  const seen: ExecutionRecord[] = [];
  let peek: () => Promise<readonly ExecutionRecord[]> = async () => [];
  const h = await harness({
    send: async () => {
      seen.push(...(await peek()));
      return 'provider-ref-1';
    },
  });
  peek = () => h.store.executionsFor(h.approval.approvalId);

  await h.executor.execute(h.approval.approvalId);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.state, 'dispatching');
  assert.equal(seen[0]?.settledAt, null);
});

test('two concurrent executes give one send and one already-consumed', async () => {
  const { store, executor, sends, approval } = await harness();

  const outcomes = await Promise.allSettled([
    executor.execute(approval.approvalId),
    executor.execute(approval.approvalId),
  ]);
  const sent = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<ExecutionRecord> =>
      outcome.status === 'fulfilled',
  );
  const refused = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );

  assert.equal(sent.length, 1);
  assert.equal(refused.length, 1);
  const reason: unknown = refused[0]?.reason;
  assert.ok(reason instanceof ExecuteError);
  assert.equal(reason.code, 'already-consumed');

  assert.equal(sends.length, 1);
  assert.equal(sent[0]?.value.state, 'sent');
  assert.equal((await store.executionsFor(approval.approvalId)).length, 1);
});

test('a second execute after a completed one sends nothing', async () => {
  const { store, executor, sends, approval } = await harness();
  await executor.execute(approval.approvalId);

  await assert.rejects(
    () => executor.execute(approval.approvalId),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'already-consumed');
      return true;
    },
  );

  assert.equal(sends.length, 1);
  assert.equal((await store.executionsFor(approval.approvalId)).length, 1);
});

test('an expired approval is refused and nothing is consumed', async () => {
  const { store, executor, sends, approval } = await harness({ executeAt: EXPIRES_AT + 1 });

  await assert.rejects(
    () => executor.execute(approval.approvalId),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'approval-expired');
      return true;
    },
  );

  assert.equal(sends.length, 0);
  assert.equal((await store.getApproval(approval.approvalId)).consumedAt, null);
  assert.deepEqual(await store.executionsFor(approval.approvalId), []);
});

test('a clock past the window is refused even while the approval is alive', async () => {
  const { store, executor, sends, approval } = await harness({
    window: { notBefore: PROPOSED_AT, notAfter: PROPOSED_AT + 5 * 60_000 },
    executeAt: PROPOSED_AT + 6 * 60_000,
  });

  await assert.rejects(
    () => executor.execute(approval.approvalId),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'outside-window');
      return true;
    },
  );

  assert.equal(sends.length, 0);
  assert.equal((await store.getApproval(approval.approvalId)).consumedAt, null);
});

test('a clock before the window is refused', async () => {
  const { executor, sends, approval } = await harness({
    window: { notBefore: PROPOSED_AT + 10 * 60_000, notAfter: PROPOSED_AT + 20 * 60_000 },
  });

  await assert.rejects(
    () => executor.execute(approval.approvalId),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'outside-window');
      return true;
    },
  );

  assert.equal(sends.length, 0);
});

test('expiry is read before the window', async () => {
  const { executor, approval } = await harness({
    window: { notBefore: PROPOSED_AT, notAfter: PROPOSED_AT + 5 * 60_000 },
    executeAt: EXPIRES_AT + 1,
  });

  await assert.rejects(
    () => executor.execute(approval.approvalId),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'approval-expired');
      return true;
    },
  );
});

test('a provider failure settles the row and leaves the approval consumed', async () => {
  const { store, executor, sends, approval } = await harness({
    send: async () => {
      throw new Error('provider timeout');
    },
  });

  const execution = await executor.execute(approval.approvalId);

  assert.equal(execution.state, 'failed');
  assert.equal(execution.failure, 'provider timeout');
  assert.equal(execution.providerRef, null);
  assert.equal(execution.settledAt, EXECUTE_AT);
  assert.equal((await store.getApproval(approval.approvalId)).consumedAt, EXECUTE_AT);

  await assert.rejects(
    () => executor.execute(approval.approvalId),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'already-consumed');
      return true;
    },
  );
  assert.equal(sends.length, 1);
});

test('an approval id the store does not hold has nothing to execute', async () => {
  const { executor } = await harness();

  await assert.rejects(
    () => executor.execute('missing'),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, 'unknown-approval');
      return true;
    },
  );
});
