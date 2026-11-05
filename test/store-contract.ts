import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  ApprovalDesk,
  defineActionType,
  ExecuteError,
  Executor,
  ProposalStore,
  Registry,
  StoreError,
  type ActionAdapter,
  type Approval,
  type ApprovalRecord,
  type ApprovalStore,
  type ApprovalWindow,
  type ExecuteErrorCode,
  type ExecutionRecord,
  type Principal,
  type RenderRequest,
  type StoreErrorCode,
} from '../src/index.ts';

const encoder = new TextEncoder();
const PROPOSED_AT = 1_700_000_000_000;
const DECIDED_AT = PROPOSED_AT + 2 * 60_000;
const EXECUTE_AT = PROPOSED_AT + 3 * 60_000;
const TTL_MS = 10 * 60_000;
const EXPIRES_AT = DECIDED_AT + TTL_MS;
const WINDOW: ApprovalWindow = { notBefore: PROPOSED_AT, notAfter: PROPOSED_AT + 15 * 60_000 };

const opsLead: Principal = { id: 'dana', kind: 'human', roles: ['ops-lead'] };

const decision: Approval = Object.freeze({
  proposalId: 'proposal-1',
  revision: 1,
  digest: 'a'.repeat(64),
  approver: 'dana',
  decidedAt: DECIDED_AT,
  expiresAt: EXPIRES_AT,
});

export interface StoreHandle {
  readonly store: ApprovalStore;
  close(): void;
}

export type OpenStore = () => StoreHandle;

export interface Scenario {
  readonly approval: Approval;
  readonly sends: Array<Record<string, unknown>>;
  executorFor(store: ApprovalStore): Executor;
}

interface ScenarioOptions {
  readonly executeAt?: number;
  readonly window?: ApprovalWindow;
  readonly send?: (action: Record<string, unknown>) => Promise<unknown>;
}

export async function scenario(options: ScenarioOptions = {}): Promise<Scenario> {
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
  const executeAt = options.executeAt ?? EXECUTE_AT;

  const proposal = await proposals.propose({
    type: 'email.send',
    target: 'ops@example.com',
    draft: { subject: 'Invoice 41' },
    window: options.window ?? WINDOW,
    proposer: 'assistant-7',
  });
  const revision = proposals.latestRevision(proposal.id);

  return {
    approval: desk.approve({
      proposalId: proposal.id,
      revision: revision.number,
      digest: revision.digest,
      approver: opsLead,
    }),
    sends,
    executorFor: (store) => new Executor(registry, proposals, store, { now: () => executeAt }),
  };
}

interface Harness {
  readonly store: ApprovalStore;
  readonly executor: Executor;
  readonly sends: Array<Record<string, unknown>>;
  readonly approval: ApprovalRecord;
  readonly digest: string;
}

function openFor(t: TestContext, open: OpenStore): ApprovalStore {
  const handle = open();
  t.after(() => {
    handle.close();
  });
  return handle.store;
}

async function harness(
  t: TestContext,
  open: OpenStore,
  options: ScenarioOptions = {},
): Promise<Harness> {
  const store = openFor(t, open);
  const { approval, sends, executorFor } = await scenario(options);
  const record = await store.recordApproval(approval);
  return {
    store,
    executor: executorFor(store),
    sends,
    approval: record,
    digest: approval.digest,
  };
}

async function refusesStore(code: StoreErrorCode, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, code);
    return true;
  });
}

async function refusesExecute(
  code: ExecuteErrorCode,
  run: () => Promise<unknown>,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ExecuteError);
    assert.equal(error.code, code);
    return true;
  });
}

export function storeContract(label: string, open: OpenStore): void {
  const name = (title: string): string => `${label}: ${title}`;

  test(name('a recorded approval reads back unconsumed'), async (t) => {
    const store = openFor(t, open);
    const record = await store.recordApproval(decision);

    assert.equal(record.proposalId, 'proposal-1');
    assert.equal(record.revision, 1);
    assert.equal(record.digest, decision.digest);
    assert.equal(record.approver, 'dana');
    assert.equal(record.decidedAt, DECIDED_AT);
    assert.equal(record.expiresAt, EXPIRES_AT);
    assert.equal(record.consumedAt, null);
    assert.equal(record.executionKey, null);
    assert.deepEqual(await store.getApproval(record.approvalId), record);
    assert.deepEqual(await store.executionsFor(record.approvalId), []);

    const again = await store.recordApproval(decision);
    assert.notEqual(again.approvalId, record.approvalId);
  });

  test(name('consumption marks the approval and writes a dispatching row'), async (t) => {
    const store = openFor(t, open);
    const record = await store.recordApproval(decision);

    const intent = await store.consumeAndRecordIntent(record.approvalId, 'key-1', EXECUTE_AT);
    assert.ok(intent);
    assert.equal(intent.executionKey, 'key-1');
    assert.equal(intent.approvalId, record.approvalId);
    assert.equal(intent.digest, decision.digest);
    assert.equal(intent.state, 'dispatching');
    assert.equal(intent.startedAt, EXECUTE_AT);
    assert.equal(intent.settledAt, null);
    assert.equal(intent.providerRef, null);
    assert.equal(intent.failure, null);

    const consumed = await store.getApproval(record.approvalId);
    assert.equal(consumed.consumedAt, EXECUTE_AT);
    assert.equal(consumed.executionKey, 'key-1');
    assert.deepEqual(await store.getExecution('key-1'), intent);
    assert.deepEqual(await store.executionsFor(record.approvalId), [intent]);
  });

  test(name('a second consumption returns null and writes nothing'), async (t) => {
    const store = openFor(t, open);
    const record = await store.recordApproval(decision);
    await store.consumeAndRecordIntent(record.approvalId, 'key-1', EXECUTE_AT);

    assert.equal(
      await store.consumeAndRecordIntent(record.approvalId, 'key-2', EXECUTE_AT + 1),
      null,
    );
    const consumed = await store.getApproval(record.approvalId);
    assert.equal(consumed.consumedAt, EXECUTE_AT);
    assert.equal(consumed.executionKey, 'key-1');
    assert.equal((await store.executionsFor(record.approvalId)).length, 1);
    await refusesStore('unknown-execution', () => store.getExecution('key-2'));
  });

  test(name('a repeated execution key is refused and consumes nothing'), async (t) => {
    const store = openFor(t, open);
    const first = await store.recordApproval(decision);
    const second = await store.recordApproval(decision);
    await store.consumeAndRecordIntent(first.approvalId, 'key-1', EXECUTE_AT);

    await refusesStore('duplicate-execution-key', () =>
      store.consumeAndRecordIntent(second.approvalId, 'key-1', EXECUTE_AT),
    );
    assert.equal((await store.getApproval(second.approvalId)).consumedAt, null);
  });

  test(name('a dispatch result settles the execution row'), async (t) => {
    const store = openFor(t, open);
    const record = await store.recordApproval(decision);
    await store.consumeAndRecordIntent(record.approvalId, 'key-1', EXECUTE_AT);

    const sent = await store.recordDispatchResult('key-1', {
      state: 'sent',
      settledAt: EXECUTE_AT + 5,
      providerRef: 'provider-ref-1',
    });
    assert.equal(sent.state, 'sent');
    assert.equal(sent.settledAt, EXECUTE_AT + 5);
    assert.equal(sent.providerRef, 'provider-ref-1');
    assert.equal(sent.failure, null);
    assert.equal(sent.startedAt, EXECUTE_AT);
    assert.deepEqual(await store.getExecution('key-1'), sent);
    assert.deepEqual(await store.executionsFor(record.approvalId), [sent]);
  });

  test(name('unknown ids are refused'), async (t) => {
    const store = openFor(t, open);
    await refusesStore('unknown-approval', () => store.getApproval('missing'));
    await refusesStore('unknown-approval', () =>
      store.consumeAndRecordIntent('missing', 'key-1', EXECUTE_AT),
    );
    await refusesStore('unknown-execution', () => store.getExecution('missing'));
    await refusesStore('unknown-execution', () =>
      store.recordDispatchResult('missing', { state: 'sent', settledAt: EXECUTE_AT }),
    );
  });

  test(name('an approval is consumed once and the send recorded after'), async (t) => {
    const { store, executor, sends, approval, digest } = await harness(t, open);

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

  test(name('the dispatching row is committed before the provider call'), async (t) => {
    const seen: ExecutionRecord[] = [];
    let peek: () => Promise<readonly ExecutionRecord[]> = async () => [];
    const h = await harness(t, open, {
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

  test(name('two concurrent executes give one send and one refusal'), async (t) => {
    const { store, executor, sends, approval } = await harness(t, open);

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

  test(name('a second execute after a completed one sends nothing'), async (t) => {
    const { store, executor, sends, approval } = await harness(t, open);
    await executor.execute(approval.approvalId);

    await refusesExecute('already-consumed', () => executor.execute(approval.approvalId));

    assert.equal(sends.length, 1);
    assert.equal((await store.executionsFor(approval.approvalId)).length, 1);
  });

  test(name('a provider failure settles the row and keeps it consumed'), async (t) => {
    const { store, executor, sends, approval } = await harness(t, open, {
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

    await refusesExecute('already-consumed', () => executor.execute(approval.approvalId));
    assert.equal(sends.length, 1);
  });

  test(name('an expired approval is refused and nothing is consumed'), async (t) => {
    const { store, executor, sends, approval } = await harness(t, open, {
      executeAt: EXPIRES_AT + 1,
    });

    await refusesExecute('approval-expired', () => executor.execute(approval.approvalId));

    assert.equal(sends.length, 0);
    assert.equal((await store.getApproval(approval.approvalId)).consumedAt, null);
    assert.deepEqual(await store.executionsFor(approval.approvalId), []);
  });

  test(name('a clock outside the window is refused'), async (t) => {
    const late = await harness(t, open, {
      window: { notBefore: PROPOSED_AT, notAfter: PROPOSED_AT + 5 * 60_000 },
      executeAt: PROPOSED_AT + 6 * 60_000,
    });
    await refusesExecute('outside-window', () => late.executor.execute(late.approval.approvalId));
    assert.equal(late.sends.length, 0);
    assert.equal((await late.store.getApproval(late.approval.approvalId)).consumedAt, null);

    const early = await harness(t, open, {
      window: { notBefore: PROPOSED_AT + 10 * 60_000, notAfter: PROPOSED_AT + 20 * 60_000 },
    });
    await refusesExecute('outside-window', () =>
      early.executor.execute(early.approval.approvalId),
    );
    assert.equal(early.sends.length, 0);
  });

  test(name('expiry is read before the window'), async (t) => {
    const { executor, approval } = await harness(t, open, {
      window: { notBefore: PROPOSED_AT, notAfter: PROPOSED_AT + 5 * 60_000 },
      executeAt: EXPIRES_AT + 1,
    });
    await refusesExecute('approval-expired', () => executor.execute(approval.approvalId));
  });

  test(name('an approval id the store does not hold has nothing to execute'), async (t) => {
    const { executor } = await harness(t, open);
    await refusesStore('unknown-approval', () => executor.execute('missing'));
  });
}
