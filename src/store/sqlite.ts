import { DatabaseSync } from 'node:sqlite';

import type { Approval } from '../approve.ts';
import {
  StoreError,
  type ApprovalRecord,
  type ApprovalStore,
  type DispatchResult,
  type ExecutionRecord,
  type ExecutionState,
} from './port.ts';

interface Migration {
  readonly number: number;
  readonly statements: readonly string[];
}

// approvals carries proposal_id and revision without a foreign key: proposals and revisions
// are still written by an in-memory store, so the referenced rows would never be there.
const MIGRATIONS: readonly Migration[] = [
  {
    number: 1,
    statements: [
      `CREATE TABLE proposals (
         id TEXT PRIMARY KEY,
         type TEXT NOT NULL,
         target TEXT NOT NULL,
         proposer TEXT NOT NULL,
         created_at INTEGER NOT NULL
       ) STRICT`,
      `CREATE TABLE revisions (
         proposal_id TEXT NOT NULL REFERENCES proposals(id),
         number INTEGER NOT NULL,
         reason TEXT NOT NULL,
         digest TEXT NOT NULL,
         payload BLOB NOT NULL,
         payload_sha256 TEXT NOT NULL,
         attachments TEXT NOT NULL,
         not_before INTEGER NOT NULL,
         not_after INTEGER NOT NULL,
         draft TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         PRIMARY KEY (proposal_id, number)
       ) STRICT`,
      `CREATE TABLE approvals (
         id TEXT PRIMARY KEY,
         proposal_id TEXT NOT NULL,
         revision INTEGER NOT NULL,
         digest TEXT NOT NULL,
         approver TEXT NOT NULL,
         decided_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         consumed_at INTEGER,
         execution_key TEXT
       ) STRICT`,
      `CREATE TABLE executions (
         execution_key TEXT PRIMARY KEY,
         approval_id TEXT NOT NULL REFERENCES approvals(id),
         digest TEXT NOT NULL,
         state TEXT NOT NULL CHECK (state IN ('dispatching', 'sent', 'failed')),
         started_at INTEGER NOT NULL,
         settled_at INTEGER,
         provider_ref TEXT,
         failure TEXT
       ) STRICT`,
      `CREATE TABLE blockers (
         id TEXT PRIMARY KEY,
         execution_key TEXT NOT NULL REFERENCES executions(execution_key),
         kind TEXT NOT NULL,
         detail TEXT NOT NULL,
         raised_at INTEGER NOT NULL,
         cleared_at INTEGER
       ) STRICT`,
      `CREATE UNIQUE INDEX approvals_execution_key ON approvals(execution_key)`,
      `CREATE INDEX executions_approval_id ON executions(approval_id)`,
    ],
  },
];

type ApprovalRow = {
  id: string;
  proposal_id: string;
  revision: number;
  digest: string;
  approver: string;
  decided_at: number;
  expires_at: number;
  consumed_at: number | null;
  execution_key: string | null;
};

type ExecutionRow = {
  execution_key: string;
  approval_id: string;
  digest: string;
  state: string;
  started_at: number;
  settled_at: number | null;
  provider_ref: string | null;
  failure: string | null;
};

export class SqliteApprovalStore implements ApprovalStore {
  readonly #db: DatabaseSync;

  constructor(location = ':memory:') {
    this.#db = new DatabaseSync(location);
    // WAL so a second connection reads committed rows while this one writes.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    migrate(this.#db);
  }

  close(): void {
    this.#db.close();
  }

  async recordApproval(approval: Approval): Promise<ApprovalRecord> {
    const approvalId = crypto.randomUUID();
    this.#db
      .prepare(
        `INSERT INTO approvals
           (id, proposal_id, revision, digest, approver, decided_at, expires_at,
            consumed_at, execution_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        approvalId,
        approval.proposalId,
        approval.revision,
        approval.digest,
        approval.approver,
        approval.decidedAt,
        approval.expiresAt,
      );
    return await this.getApproval(approvalId);
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord> {
    const row = this.#db
      .prepare('SELECT * FROM approvals WHERE id = ?')
      .get(approvalId) as ApprovalRow | undefined;
    if (row === undefined) {
      throw new StoreError(
        'unknown-approval',
        String(approvalId),
        'no approval with this id is recorded',
      );
    }
    return approvalRecord(row);
  }

  async consumeAndRecordIntent(
    approvalId: string,
    executionKey: string,
    now: number,
  ): Promise<ExecutionRecord | null> {
    const approval = await this.getApproval(approvalId);
    // BEGIN IMMEDIATE takes the write lock before the first read, so no other connection
    // can claim this execution key or this approval between the check and the insert.
    const claimed = transaction(this.#db, () => {
      const taken = this.#db
        .prepare('SELECT 1 FROM executions WHERE execution_key = ?')
        .get(executionKey);
      if (taken !== undefined) {
        throw new StoreError(
          'duplicate-execution-key',
          executionKey,
          'an execution with this key is already recorded',
        );
      }
      const consumed = this.#db
        .prepare(
          `UPDATE approvals SET consumed_at = ?, execution_key = ?
           WHERE id = ? AND consumed_at IS NULL`,
        )
        .run(now, executionKey, approvalId);
      if (Number(consumed.changes) !== 1) {
        return false;
      }
      this.#db
        .prepare(
          `INSERT INTO executions
             (execution_key, approval_id, digest, state, started_at, settled_at,
              provider_ref, failure)
           VALUES (?, ?, ?, 'dispatching', ?, NULL, NULL, NULL)`,
        )
        .run(executionKey, approvalId, approval.digest, now);
      return true;
    });
    return claimed ? await this.getExecution(executionKey) : null;
  }

  async recordDispatchResult(
    executionKey: string,
    result: DispatchResult,
  ): Promise<ExecutionRecord> {
    const settled = this.#db
      .prepare(
        `UPDATE executions SET state = ?, settled_at = ?, provider_ref = ?, failure = ?
         WHERE execution_key = ?`,
      )
      .run(
        result.state,
        result.settledAt,
        result.providerRef ?? null,
        result.failure ?? null,
        executionKey,
      );
    if (Number(settled.changes) !== 1) {
      throw new StoreError(
        'unknown-execution',
        String(executionKey),
        'no execution with this key is recorded',
      );
    }
    return await this.getExecution(executionKey);
  }

  async getExecution(executionKey: string): Promise<ExecutionRecord> {
    const row = this.#db
      .prepare('SELECT * FROM executions WHERE execution_key = ?')
      .get(executionKey) as ExecutionRow | undefined;
    if (row === undefined) {
      throw new StoreError(
        'unknown-execution',
        String(executionKey),
        'no execution with this key is recorded',
      );
    }
    return executionRecord(row);
  }

  async executionsFor(approvalId: string): Promise<readonly ExecutionRecord[]> {
    const rows = this.#db
      .prepare('SELECT * FROM executions WHERE approval_id = ? ORDER BY rowid')
      .all(approvalId) as ExecutionRow[];
    return Object.freeze(rows.map(executionRecord));
  }
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let value: T;
  try {
    value = run();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('COMMIT');
  return value;
}

function migrate(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS migrations (
       number INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     ) STRICT`,
  );
  const applied = db.prepare('SELECT number FROM migrations WHERE number = ?');
  const record = db.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)');

  for (const migration of MIGRATIONS) {
    if (applied.get(migration.number) !== undefined) {
      continue;
    }
    transaction(db, () => {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      record.run(migration.number, Date.now());
    });
  }
}

function approvalRecord(row: ApprovalRow): ApprovalRecord {
  return Object.freeze({
    approvalId: row.id,
    proposalId: row.proposal_id,
    revision: Number(row.revision),
    digest: row.digest,
    approver: row.approver,
    decidedAt: Number(row.decided_at),
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    executionKey: row.execution_key,
  });
}

function executionRecord(row: ExecutionRow): ExecutionRecord {
  return Object.freeze({
    executionKey: row.execution_key,
    approvalId: row.approval_id,
    digest: row.digest,
    state: row.state as ExecutionState,
    startedAt: Number(row.started_at),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    providerRef: row.provider_ref,
    failure: row.failure,
  });
}
