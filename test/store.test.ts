import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ExecuteError, MemoryApprovalStore, SqliteApprovalStore } from '../src/index.ts';
import { scenario, storeContract } from './store-contract.ts';

storeContract('memory', () => ({
  store: new MemoryApprovalStore(),
  close: () => {},
}));

storeContract('sqlite', () => {
  const store = new SqliteApprovalStore();
  return {
    store,
    close: () => {
      store.close();
    },
  };
});

test('a second connection to one file finds the approval already consumed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'exactsend-'));
  const writer = new SqliteApprovalStore(path.join(directory, 'approvals.db'));
  const reader = new SqliteApprovalStore(path.join(directory, 'approvals.db'));
  t.after(async () => {
    writer.close();
    reader.close();
    await rm(directory, { recursive: true, force: true });
  });

  const { approval, sends, executorFor } = await scenario();
  const record = await writer.recordApproval(approval);

  const execution = await executorFor(writer).execute(record.approvalId);
  assert.equal(execution.state, 'sent');

  await assert.rejects(
    () => executorFor(reader).execute(record.approvalId),
    (error: unknown) => {
      assert.ok(error instanceof ExecuteError);
      assert.equal(error.code, 'already-consumed');
      return true;
    },
  );

  assert.equal(sends.length, 1);
  const seen = await reader.getApproval(record.approvalId);
  assert.equal(seen.consumedAt, execution.startedAt);
  assert.equal(seen.executionKey, execution.executionKey);
  assert.deepEqual(await reader.executionsFor(record.approvalId), [execution]);
});

test('reopening a file applies no migration twice', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'exactsend-'));
  const file = path.join(directory, 'approvals.db');
  const first = new SqliteApprovalStore(file);
  const { approval } = await scenario();
  const record = await first.recordApproval(approval);
  first.close();

  const second = new SqliteApprovalStore(file);
  t.after(async () => {
    second.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal((await second.getApproval(record.approvalId)).digest, approval.digest);
});
