import type { Proposal, ProposalStore, Revision } from './proposal.ts';
import type { Registry } from './registry.ts';

export type ApprovalErrorCode =
  | 'invalid-approver'
  | 'unknown-revision'
  | 'agent-approver'
  | 'self-approval'
  | 'role-not-allowed'
  | 'stale-digest';

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  readonly path: string;

  constructor(code: ApprovalErrorCode, path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'ApprovalError';
    this.code = code;
    this.path = path;
  }
}

export type PrincipalKind = 'human' | 'agent';

export interface Principal {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly roles: readonly string[];
}

export interface ApprovalRequest {
  readonly proposalId: string;
  readonly revision: number;
  readonly digest: string;
  readonly approver: Principal;
}

export interface Approval {
  readonly proposalId: string;
  readonly revision: number;
  readonly digest: string;
  readonly approver: string;
  readonly decidedAt: number;
  readonly expiresAt: number;
}

export interface ApprovalDeskOptions {
  readonly now?: () => number;
}

export class ApprovalDesk {
  readonly #registry: Registry;
  readonly #proposals: ProposalStore;
  readonly #now: () => number;

  constructor(
    registry: Registry,
    proposals: ProposalStore,
    options: ApprovalDeskOptions = {},
  ) {
    this.#registry = registry;
    this.#proposals = proposals;
    this.#now = options.now ?? (() => Date.now());
  }

  approve(request: ApprovalRequest): Approval {
    const proposal = this.#proposals.get(request.proposalId);
    const revision = findRevision(proposal, request.revision);
    const approver = checkApprover(request.approver);
    const policy = this.#registry.policyFor(proposal.type);

    if (approver.kind === 'agent') {
      throw new ApprovalError(
        'agent-approver',
        '$.approver.kind',
        'only a human can approve an action, and no option relaxes that',
      );
    }
    if (approver.id === proposal.proposer) {
      throw new ApprovalError(
        'self-approval',
        '$.approver.id',
        'the proposer cannot approve their own proposal',
      );
    }
    if (!approver.roles.some((role) => policy.approverRoles.includes(role))) {
      throw new ApprovalError(
        'role-not-allowed',
        '$.approver.roles',
        `none of these roles approves ${proposal.type}`,
      );
    }
    if (request.digest !== revision.digest) {
      throw new ApprovalError(
        'stale-digest',
        '$.digest',
        `this is not the digest of revision ${String(revision.number)}, so it is not what was reviewed`,
      );
    }

    const decidedAt = this.#now();
    return Object.freeze({
      proposalId: proposal.id,
      revision: revision.number,
      digest: revision.digest,
      approver: approver.id,
      decidedAt,
      expiresAt: decidedAt + policy.ttlMs,
    });
  }
}

function findRevision(proposal: Proposal, number: number): Revision {
  for (const revision of proposal.revisions) {
    if (revision.number === number) {
      return revision;
    }
  }
  throw new ApprovalError(
    'unknown-revision',
    `${proposal.id}#${String(number)}`,
    'this proposal has no revision with that number',
  );
}

function checkApprover(value: unknown): Principal {
  if (typeof value !== 'object' || value === null) {
    throw new ApprovalError(
      'invalid-approver',
      '$.approver',
      'approver must be a principal holding id, kind and roles',
    );
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const kind = record.kind;
  const roles = record.roles;

  if (typeof id !== 'string' || id.length === 0) {
    throw new ApprovalError(
      'invalid-approver',
      '$.approver.id',
      'id must be a non-empty string naming who decided',
    );
  }
  if (!isPrincipalKind(kind)) {
    throw new ApprovalError(
      'invalid-approver',
      '$.approver.kind',
      "kind must be 'human' or 'agent'",
    );
  }
  if (!Array.isArray(roles)) {
    throw new ApprovalError(
      'invalid-approver',
      '$.approver.roles',
      'roles must be an array of role names',
    );
  }
  const list = roles as unknown[];
  if (list.some((role) => typeof role !== 'string' || role.length === 0)) {
    throw new ApprovalError(
      'invalid-approver',
      '$.approver.roles',
      'every role must be a non-empty string',
    );
  }
  return Object.freeze({ id, kind, roles: Object.freeze([...(list as string[])]) });
}

function isPrincipalKind(value: unknown): value is PrincipalKind {
  return value === 'human' || value === 'agent';
}
