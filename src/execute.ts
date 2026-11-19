import type { ProviderStatus, RegisteredAdapter } from './adapters/types.ts';
import type { Proposal, ProposalStore, Revision } from './proposal.ts';
import type { ActionAdapter, Registry } from './registry.ts';
import type { ApprovalStore, DispatchResult, ExecutionRecord } from './store/port.ts';

const EXECUTION_KEY_DOMAIN = 'exactsend/exec/v1\n';

const encoder = new TextEncoder();

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export type ExecuteErrorCode =
  | 'approval-expired'
  | 'outside-window'
  | 'render-drift'
  | 'already-consumed'
  | 'unknown-revision'
  | 'not-resumable'
  | 'status-unavailable';

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

// What an adapter throws when the provider call ran out of time. It answers nothing about
// the bytes, so the execution is recorded unknown rather than failed.
export class SendTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendTimeoutError';
  }
}

export interface ExecutorOptions {
  readonly now?: () => number;
}

// Derived from the approval, never drawn at random: an execution that crashed between the
// commit and the result reuses exactly the key the provider already saw, and two approvals
// can never share one.
export async function executionKeyFor(approvalId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(EXECUTION_KEY_DOMAIN + approvalId),
  );
  return toHex(new Uint8Array(digest));
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

    // Rendering again before consuming: a template, footer or link rewrite that moved since
    // the decision renders to another digest, and that digest was never approved.
    const rendered = await this.#proposals.rerender(proposal.id, revision.number);
    if (rendered.digest !== approval.digest) {
      throw new ExecuteError(
        'render-drift',
        approvalId,
        `the draft now renders as ${rendered.digest}, not the approved ${approval.digest}`,
      );
    }

    const intent = await this.#store.consumeAndRecordIntent(
      approvalId,
      await executionKeyFor(approvalId),
      now,
    );
    if (intent === null) {
      throw new ExecuteError(
        'already-consumed',
        approvalId,
        'an execution already consumed this approval, so nothing was sent',
      );
    }

    return await this.#store.recordDispatchResult(
      intent.executionKey,
      await this.#dispatch(adapter, proposal, revision, intent.executionKey),
    );
  }

  // Finishes an execution the provider never answered for. A resend is only one of the three
  // ways out, and never the first thing tried unless the provider deduplicates.
  async resume(executionKey: string): Promise<ExecutionRecord> {
    const execution = await this.#store.getExecution(executionKey);
    if (execution.state !== 'dispatching' && execution.state !== 'unknown') {
      throw new ExecuteError(
        'not-resumable',
        executionKey,
        `an execution in state ${execution.state} has nothing left to resolve`,
      );
    }
    const approval = await this.#store.getApproval(execution.approvalId);
    const proposal = this.#proposals.get(approval.proposalId);
    const revision = findRevision(proposal, approval.revision);
    const adapter = this.#registry.adapterFor(proposal.type);
    const capabilities = adapter as Partial<RegisteredAdapter>;

    if (capabilities.honoursIdempotencyKey === true) {
      return await this.#store.recordDispatchResult(
        executionKey,
        await this.#dispatch(adapter, proposal, revision, executionKey),
      );
    }

    const queryStatus = capabilities.queryStatus;
    if (queryStatus === undefined) {
      return await this.#park(
        execution.executionKey,
        execution.failure,
        `${proposal.type} neither honours idempotency keys nor answers a status query`,
      );
    }

    let status: ProviderStatus;
    try {
      status = await queryStatus.call(adapter, executionKey);
    } catch (error) {
      // Nothing was asked, so nothing is known: the row stays unknown and can be asked again.
      throw new ExecuteError(
        'status-unavailable',
        executionKey,
        `the provider could not be asked about this send: ${message(error)}`,
      );
    }

    if (status.state === 'sent') {
      return await this.#store.recordDispatchResult(executionKey, {
        state: 'delivered',
        settledAt: this.#now(),
        providerRef: status.providerRef,
      });
    }
    if (status.state === 'unknown') {
      return await this.#park(
        executionKey,
        execution.failure,
        `${proposal.type} answered unknown, so a resend could be a second delivery`,
      );
    }
    // not-sent is the only definite answer that lets the approved bytes go out again.
    return await this.#store.recordDispatchResult(
      executionKey,
      await this.#dispatch(adapter, proposal, revision, executionKey),
    );
  }

  async #dispatch(
    adapter: ActionAdapter,
    proposal: Proposal,
    revision: Revision,
    executionKey: string,
  ): Promise<DispatchResult> {
    try {
      // The stored bytes, not the ones just rendered: the approver's bytes go on the wire.
      const sent: unknown = await adapter.send({
        type: proposal.type,
        target: proposal.target,
        digest: revision.digest,
        executionKey,
        payload: revision.payload,
        attachments: revision.attachments,
      });
      return {
        state: 'sent',
        settledAt: this.#now(),
        providerRef: typeof sent === 'string' ? sent : null,
      };
    } catch (error) {
      if (isTimeout(error)) {
        return { state: 'unknown', settledAt: null, failure: message(error) };
      }
      return { state: 'failed', settledAt: this.#now(), failure: message(error) };
    }
  }

  async #park(
    executionKey: string,
    failure: string | null,
    detail: string,
  ): Promise<ExecutionRecord> {
    return await this.#store.recordDispatchResult(executionKey, {
      state: 'parked',
      settledAt: null,
      blocker: 'needs-human',
      failure: failure === null ? detail : `${failure} (${detail})`,
    });
  }
}

// Recognised by shape, not by wording: an ordinary Error whose message mentions a timeout is
// a failure like any other, because nothing about it says the bytes might have landed.
function isTimeout(error: unknown): boolean {
  if (error instanceof SendTimeoutError) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const shape = error as { name?: unknown; code?: unknown };
  if (shape.name === 'TimeoutError' || shape.name === 'AbortError') {
    return true;
  }
  return typeof shape.code === 'string' && TIMEOUT_CODES.has(shape.code);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
