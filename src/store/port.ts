import type { Approval } from '../approve.ts';

export type StoreErrorCode =
  | 'unknown-approval'
  | 'unknown-execution'
  | 'duplicate-execution-key';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly path: string;

  constructor(code: StoreErrorCode, path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'StoreError';
    this.code = code;
    this.path = path;
  }
}

// 'unknown' is not a failure: the provider answered nothing, so the bytes may or may not be
// on the wire. 'delivered' is an unknown the provider later confirmed, and 'parked' is one
// that nothing but a human can resolve.
export type ExecutionState =
  | 'dispatching'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'delivered'
  | 'parked';

export type ExecutionBlocker = 'needs-human';

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly digest: string;
  readonly approver: string;
  readonly decidedAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
  readonly executionKey: string | null;
}

export interface ExecutionRecord {
  readonly executionKey: string;
  readonly approvalId: string;
  readonly digest: string;
  readonly state: ExecutionState;
  readonly startedAt: number;
  readonly settledAt: number | null;
  readonly providerRef: string | null;
  readonly failure: string | null;
  readonly blocker: ExecutionBlocker | null;
}

export interface DispatchResult {
  readonly state: Exclude<ExecutionState, 'dispatching'>;
  // Null while the execution is not settled: an unknown or parked row is still open.
  readonly settledAt: number | null;
  readonly providerRef?: string | null;
  readonly failure?: string | null;
  readonly blocker?: ExecutionBlocker | null;
}

export interface ApprovalStore {
  recordApproval(approval: Approval): Promise<ApprovalRecord>;

  getApproval(approvalId: string): Promise<ApprovalRecord>;

  // One step: the approval is marked consumed only where it was not consumed, and the
  // dispatching execution row is written with it. A null return means no row changed, so
  // the approval was already spent and nothing may be sent. Consumption is read before the
  // execution key, so a second attempt under the derived key reads as already consumed
  // rather than as a clash with its own first attempt.
  consumeAndRecordIntent(
    approvalId: string,
    executionKey: string,
    now: number,
  ): Promise<ExecutionRecord | null>;

  recordDispatchResult(
    executionKey: string,
    result: DispatchResult,
  ): Promise<ExecutionRecord>;

  getExecution(executionKey: string): Promise<ExecutionRecord>;

  executionsFor(approvalId: string): Promise<readonly ExecutionRecord[]>;
}
