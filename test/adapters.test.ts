import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionAdapter,
  ApprovalDesk,
  defineActionType,
  emailAdapter,
  ExecuteError,
  Executor,
  FakeEmailProvider,
  MemoryApprovalStore,
  ProposalStore,
  Registry,
  WebhookAdapter,
  type ActionAdapter,
  type EmailTemplate,
  type ExecutionRecord,
  type Principal,
  type Revision,
  type WebhookFetch,
  type WebhookRequest,
} from '../src/index.ts';

const decoder = new TextDecoder();
const PROPOSED_AT = 1_700_000_000_000;
const DECIDED_AT = PROPOSED_AT + 2 * 60_000;
const EXECUTE_AT = PROPOSED_AT + 3 * 60_000;

const opsLead: Principal = { id: 'dana', kind: 'human', roles: ['ops-lead'] };

interface Flow {
  readonly store: MemoryApprovalStore;
  readonly approvalId: string;
  readonly revision: Revision;
  execute(): Promise<ExecutionRecord>;
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
    draft: { subject: 'Invoice 41', body: 'Attached.' },
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
  const executor = new Executor(registry, proposals, store, { now: () => EXECUTE_AT });

  return {
    store,
    approvalId: record.approvalId,
    revision,
    execute: () => executor.execute(record.approvalId),
  };
}

test('the fake provider receives exactly the approved bytes', async () => {
  const provider = new FakeEmailProvider();
  const run = await flow(actionAdapter(emailAdapter({ provider })));

  const execution = await run.execute();

  assert.equal(execution.state, 'sent');
  assert.equal(execution.providerRef, 'fake-email-1');
  assert.equal(provider.delivered.length, 1);
  const delivered = provider.delivered[0];
  assert.ok(delivered);
  assert.deepEqual(delivered.bytes, run.revision.payload);
  assert.equal(delivered.idempotencyKey, execution.executionKey);
  assert.equal(
    decoder.decode(delivered.bytes),
    'To: ops@example.com\nSubject: Invoice 41\n\nAttached.',
  );
});

test('a template changed after approval refuses the send', async () => {
  let trailer = '';
  const template: EmailTemplate = (draft, target) =>
    `To: ${target}\nSubject: ${String(draft.subject)}\n\n${String(draft.body)}${trailer}`;
  const provider = new FakeEmailProvider();
  const run = await flow(actionAdapter(emailAdapter({ provider, template })));

  trailer = '\n\nUnsubscribe: https://example.com/u/41';

  await assert.rejects(
    () => run.execute(),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'render-drift');
      return true;
    },
  );

  assert.equal(provider.delivered.length, 0);
  assert.equal((await run.store.getApproval(run.approvalId)).consumedAt, null);
  assert.deepEqual(await run.store.executionsFor(run.approvalId), []);
});

test('a webhook posts the approved bytes under the execution key', async () => {
  const calls: Array<{ url: string; request: WebhookRequest }> = [];
  const fetchStub: WebhookFetch = async (url, request) => {
    calls.push({ url, request });
    return { ok: true, status: 202, text: async () => 'hook-1' };
  };
  const run = await flow(
    actionAdapter(
      new WebhookAdapter({
        url: 'https://example.com/hooks/send',
        fetch: fetchStub,
        honoursIdempotencyKey: true,
      }),
    ),
  );

  const execution = await run.execute();

  assert.equal(execution.state, 'sent');
  assert.equal(execution.providerRef, 'hook-1');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://example.com/hooks/send');
  assert.equal(call.request.method, 'POST');
  assert.equal(call.request.headers['Content-Type'], 'application/json');
  assert.equal(call.request.headers['Idempotency-Key'], execution.executionKey);
  assert.deepEqual(call.request.body, run.revision.payload);
  assert.equal(
    decoder.decode(call.request.body),
    '{"draft":{"body":"Attached.","subject":"Invoice 41"},"target":"ops@example.com"}',
  );
});

test('a webhook that refuses settles the execution as failed', async () => {
  const fetchStub: WebhookFetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'busy',
  });
  const run = await flow(
    actionAdapter(
      new WebhookAdapter({ url: 'https://example.com/hooks/send', fetch: fetchStub }),
    ),
  );

  const execution = await run.execute();

  assert.equal(execution.state, 'failed');
  assert.match(execution.failure ?? '', /503/);
  assert.equal((await run.store.getApproval(run.approvalId)).consumedAt, EXECUTE_AT);
});
