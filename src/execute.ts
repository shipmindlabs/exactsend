import type { Proposal, ProposalStore, Revision } from './proposal.ts';
import type { Registry } from './registry.ts';
import type { ApprovalStore, DispatchResult, ExecutionRecord } from './store/port.ts';

export type ExecuteErrorCode =
  | 'approval-expired'
  | 'outside-window'
  | 'already-consumed'
  | 'unknown-revision';

export class ExecuteError extends Error {
  readonly code: ExecuteErrorCode;
  readonly path: string;

  constructor(code: ExecuteErrorCode, path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'ExecuteError';
    this.code = code;
    this.path = path;
  }
}

export interface ExecutorOptions {
  readonly now?: () => number;
}

export class Executor {
  readonly #registry: Registry;
  readonly #proposals: ProposalStore;
  readonly #store: ApprovalStore;
  readonly #now: () => number;

  constructor(
    registry: Registry,
    proposals: ProposalStore,
    store: ApprovalStore,
    options: ExecutorOptions = {},
  ) {
    this.#registry = registry;
    this.#proposals = proposals;
    this.#store = store;
    this.#now = options.now ?? (() => Date.now());
  }

  async execute(approvalId: string): Promise<ExecutionRecord> {
    const approval = await this.#store.getApproval(approvalId);
    const proposal = this.#proposals.get(approval.proposalId);
    const revision = findRevision(proposal, approval.revision);
    const adapter = this.#registry.adapterFor(proposal.type);
    const now = this.#now();

    if (now > approval.expiresAt) {
      throw new ExecuteError(
        'approval-expired',
        approvalId,
        `this approval expired at ${String(approval.expiresAt)}, so it decides nothing now`,
      );
    }
    if (now < revision.window.notBefore || now > revision.window.notAfter) {
      throw new ExecuteError(
        'outside-window',
        approvalId,
        'the clock is outside the window the approver saw on this revision',
      );
    }

    const intent = await this.#store.consumeAndRecordIntent(
      approvalId,
      crypto.randomUUID(),
      now,
    );
    if (intent === null) {
      throw new ExecuteError(
        'already-consumed',
        approvalId,
        'an execution already consumed this approval, so nothing was sent',
      );
    }

    let result: DispatchResult;
    try {
      const sent: unknown = await adapter.send({
        type: proposal.type,
        target: proposal.target,
        digest: revision.digest,
        executionKey: intent.executionKey,
        payload: revision.payload,
        attachments: revision.attachments,
      });
      result = {
        state: 'sent',
        settledAt: this.#now(),
        providerRef: typeof sent === 'string' ? sent : null,
      };
    } catch (error) {
      result = {
        state: 'failed',
        settledAt: this.#now(),
        failure: error instanceof Error ? error.message : String(error),
      };
    }
    return await this.#store.recordDispatchResult(intent.executionKey, result);
  }
}

function findRevision(proposal: Proposal, number: number): Revision {
  for (const revision of proposal.revisions) {
    if (revision.number === number) {
      return revision;
    }
  }
  throw new ExecuteError(
    'unknown-revision',
    `${proposal.id}#${String(number)}`,
    'this proposal has no revision with that number',
  );
}
