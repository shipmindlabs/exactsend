import type { Approval } from '../approve.ts';
import {
  StoreError,
  type ApprovalRecord,
  type ApprovalStore,
  type DispatchResult,
  type ExecutionRecord,
} from './port.ts';

export class MemoryApprovalStore implements ApprovalStore {
  readonly #approvals = new Map<string, ApprovalRecord>();
  readonly #executions = new Map<string, ExecutionRecord>();

  async recordApproval(approval: Approval): Promise<ApprovalRecord> {
    const record: ApprovalRecord = Object.freeze({
      approvalId: crypto.randomUUID(),
      proposalId: approval.proposalId,
      revision: approval.revision,
      digest: approval.digest,
      approver: approval.approver,
      decidedAt: approval.decidedAt,
      expiresAt: approval.expiresAt,
      consumedAt: null,
      executionKey: null,
    });
    this.#approvals.set(record.approvalId, record);
    return record;
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord> {
    return this.#approval(approvalId);
  }

  async consumeAndRecordIntent(
    approvalId: string,
    executionKey: string,
    now: number,
  ): Promise<ExecutionRecord | null> {
    const approval = this.#approval(approvalId);
    if (this.#executions.has(executionKey)) {
      throw new StoreError(
        'duplicate-execution-key',
        executionKey,
        'an execution with this key is already recorded',
      );
    }
    if (approval.consumedAt !== null) {
      return null;
    }

    const execution: ExecutionRecord = Object.freeze({
      executionKey,
      approvalId,
      digest: approval.digest,
      state: 'dispatching',
      startedAt: now,
      settledAt: null,
      providerRef: null,
      failure: null,
    });
    this.#approvals.set(
      approvalId,
      Object.freeze({ ...approval, consumedAt: now, executionKey }),
    );
    this.#executions.set(executionKey, execution);
    return execution;
  }

  async recordDispatchResult(
    executionKey: string,
    result: DispatchResult,
  ): Promise<ExecutionRecord> {
    const current = this.#execution(executionKey);
    const next: ExecutionRecord = Object.freeze({
      ...current,
      state: result.state,
      settledAt: result.settledAt,
      providerRef: result.providerRef ?? null,
      failure: result.failure ?? null,
    });
    this.#executions.set(executionKey, next);
    return next;
  }

  async getExecution(executionKey: string): Promise<ExecutionRecord> {
    return this.#execution(executionKey);
  }

  async executionsFor(approvalId: string): Promise<readonly ExecutionRecord[]> {
    const rows: ExecutionRecord[] = [];
    for (const execution of this.#executions.values()) {
      if (execution.approvalId === approvalId) {
        rows.push(execution);
      }
    }
    return Object.freeze(rows);
  }

  #approval(approvalId: string): ApprovalRecord {
    const record = this.#approvals.get(approvalId);
    if (record === undefined) {
      throw new StoreError(
        'unknown-approval',
        String(approvalId),
        'no approval with this id is recorded',
      );
    }
    return record;
  }

  #execution(executionKey: string): ExecutionRecord {
    const record = this.#executions.get(executionKey);
    if (record === undefined) {
      throw new StoreError(
        'unknown-execution',
        String(executionKey),
        'no execution with this key is recorded',
      );
    }
    return record;
  }
}
