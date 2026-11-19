import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionAdapter,
  ApprovalDesk,
  defineActionType,
  emailAdapter,
  ExecuteError,
  Executor,
  executionKeyFor,
  MemoryApprovalStore,
  ProposalStore,
  Registry,
  SendTimeoutError,
  StoreError,
  type ActionAdapter,
  type Adapter,
  type Principal,
  type ProviderStatus,
} from '../src/index.ts';

const encoder = new TextEncoder();
const PROPOSED_AT = 1_700_000_000_000;
const DECIDED_AT = PROPOSED_AT + 2 * 60_000;
const EXECUTE_AT = PROPOSED_AT + 3 * 60_000;

const opsLead: Principal = { id: 'dana', kind: 'human', roles: ['ops-lead'] };

interface Delivery {
  readonly idempotencyKey: string;
  readonly providerRef: string;
}

interface ProviderOptions {
  readonly timeouts?: number;
  readonly commitOnTimeout?: boolean;
}

// Commits the message and then times out: the call answers nothing although the bytes are
// already on the provider's side.
class FlakyProvider {
  readonly delivered: Delivery[] = [];
  statusAnswer: 'as-delivered' | 'unknown' | 'throw' = 'as-delivered';
  readonly #byKey = new Map<string, Delivery>();
  readonly #commitOnTimeout: boolean;
  #timeouts: number;

  constructor(options: ProviderOptions = {}) {
    this.#timeouts = options.timeouts ?? 1;
    this.#commitOnTimeout = options.commitOnTimeout ?? true;
  }

  async deliver(_bytes: Uint8Array, idempotencyKey: string): Promise<string> {
    const seen = this.#byKey.get(idempotencyKey);
    if (seen !== undefined) {
      return seen.providerRef;
    }
    if (this.#timeouts > 0) {
      this.#timeouts -= 1;
      if (this.#commitOnTimeout) {
        this.#commit(idempotencyKey);
      }
      throw new SendTimeoutError('the provider did not answer within 10s');
    }
    return this.#commit(idempotencyKey).providerRef;
  }

  async status(idempotencyKey: string): Promise<ProviderStatus> {
    if (this.statusAnswer === 'throw') {
      throw new Error('the status endpoint is unreachable');
    }
    if (this.statusAnswer === 'unknown') {
      return { state: 'unknown', providerRef: null };
    }
    const seen = this.#byKey.get(idempotencyKey);
    return seen === undefined
      ? { state: 'not-sent', providerRef: null }
      : { state: 'sent', providerRef: seen.providerRef };
  }

  #commit(idempotencyKey: string): Delivery {
    const delivery: Delivery = {
      idempotencyKey,
      providerRef: `ref-${String(this.delivered.length + 1)}`,
    };
    this.delivered.push(delivery);
    this.#byKey.set(idempotencyKey, delivery);
    return delivery;
  }
}

function render(draft: Record<string, unknown>, target: string): Uint8Array {
  return encoder.encode(`To: ${target}\nSubject: ${String(draft.subject ?? '')}`);
}

function reconcilable(provider: FlakyProvider): Adapter {
  return {
    honoursIdempotencyKey: false,
    render,
    send: async (bytes, { executionKey }) => await provider.deliver(bytes, executionKey),
    queryStatus: async (executionKey) => await provider.status(executionKey),
  };
}

function blind(provider: FlakyProvider): Adapter {
  return {
    honoursIdempotencyKey: false,
    render,
    send: async (bytes, { executionKey }) => await provider.deliver(bytes, executionKey),
  };
}

interface Flow {
  readonly store: MemoryApprovalStore;
  readonly executor: Executor;
  readonly approvalId: string;
}

async function flow(adapter: ActionAdapter): Promise<Flow> {
  const registry = new Registry([
    defineActionType({
      name: 'email.send',
      reversible: false,
      ttlMs: 10 * 60_000,
      maxWindowMs: 60 * 60_000,
      approverRoles: ['ops-lead'],
      maxBatch: 5,
      adapter,
    }),
  ]);
  const proposals = new ProposalStore(registry, { now: () => PROPOSED_AT });
  const desk = new ApprovalDesk(registry, proposals, { now: () => DECIDED_AT });
  const store = new MemoryApprovalStore();

  const proposal = await proposals.propose({
    type: 'email.send',
    target: 'ops@example.com',
    draft: { subject: 'Invoice 41' },
    window: { notBefore: PROPOSED_AT, notAfter: PROPOSED_AT + 15 * 60_000 },
    proposer: 'assistant-7',
  });
  const revision = proposals.latestRevision(proposal.id);
  const record = await store.recordApproval(
    desk.approve({
      proposalId: proposal.id,
      revision: revision.number,
      digest: revision.digest,
      approver: opsLead,
    }),
  );

  return {
    store,
    executor: new Executor(registry, proposals, store, { now: () => EXECUTE_AT }),
    approvalId: record.approvalId,
  };
}

test('the execution key is derived from the approval, not drawn at random', async () => {
  const run = await flow(
    actionAdapter(emailAdapter({ provider: new FlakyProvider({ timeouts: 0 }) })),
  );

  const execution = await run.executor.execute(run.approvalId);

  assert.match(execution.executionKey, /^[0-9a-f]{64}$/);
  assert.equal(execution.executionKey, await executionKeyFor(run.approvalId));
  assert.notEqual(await executionKeyFor('approval-a'), await executionKeyFor('approval-b'));
});

test('a send that times out leaves the execution unknown, never failed', async () => {
  const provider = new FlakyProvider();
  const run = await flow(actionAdapter(emailAdapter({ provider })));

  const execution = await run.executor.execute(run.approvalId);

  assert.equal(execution.state, 'unknown');
  assert.equal(execution.settledAt, null);
  assert.equal(execution.providerRef, null);
  assert.equal(execution.blocker, null);
  assert.match(execution.failure ?? '', /did not answer/);
  assert.equal(provider.delivered.length, 1);
  assert.equal((await run.store.getApproval(run.approvalId)).consumedAt, EXECUTE_AT);

  await assert.rejects(
    () => run.executor.execute(run.approvalId),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'already-consumed');
      return true;
    },
  );
  assert.equal(provider.delivered.length, 1);
});

test('a provider that deduplicates is resent under the same key', async () => {
  const provider = new FlakyProvider();
  const run = await flow(actionAdapter(emailAdapter({ provider })));
  const unknown = await run.executor.execute(run.approvalId);

  const resumed = await run.executor.resume(unknown.executionKey);

  assert.equal(resumed.state, 'sent');
  assert.equal(resumed.executionKey, unknown.executionKey);
  assert.equal(resumed.providerRef, 'ref-1');
  assert.equal(resumed.settledAt, EXECUTE_AT);
  assert.equal(provider.delivered.length, 1);
  assert.equal((await run.store.executionsFor(run.approvalId)).length, 1);
});

test('a provider that cannot deduplicate is asked before anything is resent', async () => {
  const provider = new FlakyProvider();
  const run = await flow(actionAdapter(reconcilable(provider)));
  const unknown = await run.executor.execute(run.approvalId);
  assert.equal(unknown.state, 'unknown');

  const resumed = await run.executor.resume(unknown.executionKey);

  assert.equal(resumed.state, 'delivered');
  assert.equal(resumed.providerRef, 'ref-1');
  assert.equal(resumed.settledAt, EXECUTE_AT);
  assert.equal(provider.delivered.length, 1);
});

test('only a definite not-found resends the approved bytes', async () => {
  const provider = new FlakyProvider({ commitOnTimeout: false });
  const run = await flow(actionAdapter(reconcilable(provider)));
  const unknown = await run.executor.execute(run.approvalId);
  assert.equal(unknown.state, 'unknown');
  assert.equal(provider.delivered.length, 0);

  const resumed = await run.executor.resume(unknown.executionKey);

  assert.equal(resumed.state, 'sent');
  assert.equal(resumed.providerRef, 'ref-1');
  assert.equal(provider.delivered.length, 1);
});

test('a provider that answers unknown parks the execution for a human', async () => {
  const provider = new FlakyProvider();
  provider.statusAnswer = 'unknown';
  const run = await flow(actionAdapter(reconcilable(provider)));
  const unknown = await run.executor.execute(run.approvalId);

  const parked = await run.executor.resume(unknown.executionKey);

  assert.equal(parked.state, 'parked');
  assert.equal(parked.blocker, 'needs-human');
  assert.equal(parked.settledAt, null);
  assert.match(parked.failure ?? '', /did not answer/);
  assert.equal(provider.delivered.length, 1);
});

test('an adapter with neither capability parks the execution for a human', async () => {
  const provider = new FlakyProvider();
  const run = await flow(actionAdapter(blind(provider)));
  const unknown = await run.executor.execute(run.approvalId);

  const parked = await run.executor.resume(unknown.executionKey);

  assert.equal(parked.state, 'parked');
  assert.equal(parked.blocker, 'needs-human');
  assert.equal(provider.delivered.length, 1);

  await assert.rejects(
    () => run.executor.resume(unknown.executionKey),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'not-resumable');
      return true;
    },
  );
  assert.equal(provider.delivered.length, 1);
});

test('a status query that cannot be reached leaves the row unknown', async () => {
  const provider = new FlakyProvider();
  provider.statusAnswer = 'throw';
  const run = await flow(actionAdapter(reconcilable(provider)));
  const unknown = await run.executor.execute(run.approvalId);

  await assert.rejects(
    () => run.executor.resume(unknown.executionKey),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'status-unavailable');
      return true;
    },
  );

  assert.equal((await run.store.getExecution(unknown.executionKey)).state, 'unknown');
  assert.equal(provider.delivered.length, 1);
});

test('a settled execution has nothing to resume', async () => {
  const provider = new FlakyProvider({ timeouts: 0 });
  const run = await flow(actionAdapter(emailAdapter({ provider })));
  const execution = await run.executor.execute(run.approvalId);
  assert.equal(execution.state, 'sent');

  await assert.rejects(
    () => run.executor.resume(execution.executionKey),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'not-resumable');
      return true;
    },
  );
  assert.equal(provider.delivered.length, 1);
});

test('an ordinary error is still a failure, however it is worded', async () => {
  const adapter = actionAdapter({
    honoursIdempotencyKey: true,
    render,
    send: async () => {
      throw new Error('provider timeout');
    },
  });
  const run = await flow(adapter);

  const execution = await run.executor.execute(run.approvalId);

  assert.equal(execution.state, 'failed');
  assert.equal(execution.failure, 'provider timeout');
  assert.equal(execution.settledAt, EXECUTE_AT);
});

test('an execution key the store does not hold cannot be resumed', async () => {
  const run = await flow(actionAdapter(emailAdapter({ provider: new FlakyProvider() })));

  await assert.rejects(
    () => run.executor.resume('a-key-nobody-sent'),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, 'unknown-execution');
      return true;
    },
  );
});
