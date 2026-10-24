import { actionDigest } from './canonical.ts';
import type { Registry } from './registry.ts';

export type ProposalErrorCode =
  | 'unknown-proposal'
  | 'invalid-target'
  | 'invalid-proposer'
  | 'invalid-draft'
  | 'invalid-attachment'
  | 'invalid-window'
  | 'window-too-wide'
  | 'adapter-cannot-render'
  | 'invalid-payload';

export class ProposalError extends Error {
  readonly code: ProposalErrorCode;
  readonly path: string;

  constructor(code: ProposalErrorCode, path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'ProposalError';
    this.code = code;
    this.path = path;
  }
}

export interface Attachment {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export interface RenderRequest {
  readonly type: string;
  readonly target: string;
  readonly draft: Record<string, unknown>;
  readonly attachments: readonly Attachment[];
}

export interface ActionRenderer {
  render(request: RenderRequest): Uint8Array | Promise<Uint8Array>;
}

export interface ApprovalWindow {
  readonly notBefore: number;
  readonly notAfter: number;
}

export interface AttachmentRecord {
  readonly filename: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export type RevisionReason = 'proposed' | 'edited' | 'rescheduled';

export interface Revision {
  readonly number: number;
  readonly reason: RevisionReason;
  readonly digest: string;
  readonly payload: Uint8Array;
  readonly payloadSha256: string;
  readonly attachments: readonly AttachmentRecord[];
  readonly window: ApprovalWindow;
  readonly draft: Record<string, unknown>;
  readonly createdAt: number;
}

export interface Proposal {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly proposer: string;
  readonly revisions: readonly Revision[];
}

export interface ProposalInput {
  readonly type: string;
  readonly target: string;
  readonly draft: Record<string, unknown>;
  readonly attachments?: readonly Attachment[];
  readonly window: ApprovalWindow;
  readonly proposer: string;
}

export interface ProposalStoreOptions {
  readonly now?: () => number;
}

interface ProposalRecord {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly proposer: string;
  readonly attachments: readonly Attachment[];
  readonly attachmentRecords: readonly AttachmentRecord[];
  readonly revisions: Revision[];
}

export class ProposalStore {
  readonly #registry: Registry;
  readonly #now: () => number;
  readonly #records = new Map<string, ProposalRecord>();

  constructor(registry: Registry, options: ProposalStoreOptions = {}) {
    this.#registry = registry;
    this.#now = options.now ?? (() => Date.now());
  }

  async propose(input: ProposalInput): Promise<Proposal> {
    const renderer = this.#rendererFor(input.type);
    const policy = this.#registry.policyFor(input.type);
    const target = checkTarget(input.target);
    const proposer = checkProposer(input.proposer);
    const draft = checkDraft(input.draft);
    const attachments = checkAttachments(input.attachments ?? []);
    const window = checkWindow(input.window, policy.maxWindowMs, '$.window');

    const record: ProposalRecord = {
      id: crypto.randomUUID(),
      type: policy.name,
      target,
      proposer,
      attachments,
      attachmentRecords: await describeAttachments(attachments),
      revisions: [],
    };
    this.#records.set(record.id, record);
    return await this.#append(record, renderer, 'proposed', draft, window);
  }

  async edit(proposalId: string, draft: Record<string, unknown>): Promise<Proposal> {
    const record = this.#record(proposalId);
    const renderer = this.#rendererFor(record.type);
    const window = this.#latest(record).window;
    return await this.#append(record, renderer, 'edited', checkDraft(draft), window);
  }

  async reschedule(proposalId: string, window: ApprovalWindow): Promise<Proposal> {
    const record = this.#record(proposalId);
    const renderer = this.#rendererFor(record.type);
    const policy = this.#registry.policyFor(record.type);
    const draft = this.#latest(record).draft;
    const next = checkWindow(window, policy.maxWindowMs, '$.window');
    return await this.#append(record, renderer, 'rescheduled', draft, next);
  }

  get(proposalId: string): Proposal {
    return view(this.#record(proposalId));
  }

  latestRevision(proposalId: string): Revision {
    return this.#latest(this.#record(proposalId));
  }

  async #append(
    record: ProposalRecord,
    renderer: ActionRenderer,
    reason: RevisionReason,
    draft: Record<string, unknown>,
    window: ApprovalWindow,
  ): Promise<Proposal> {
    const payload = await renderPayload(renderer, {
      type: record.type,
      target: record.target,
      draft,
      attachments: record.attachments,
    });
    const payloadSha256 = await sha256Hex(payload);
    const digest = await actionDigest({
      type: record.type,
      target: record.target,
      payloadSha256,
      attachments: record.attachmentRecords.map((attachment) => attachment.sha256),
      window: { notBefore: window.notBefore, notAfter: window.notAfter },
    });

    record.revisions.push(
      Object.freeze({
        number: record.revisions.length + 1,
        reason,
        digest,
        payload,
        payloadSha256,
        attachments: record.attachmentRecords,
        window,
        draft,
        createdAt: this.#now(),
      }),
    );
    return view(record);
  }

  #rendererFor(type: string): ActionRenderer {
    const adapter: unknown = this.#registry.adapterFor(type);
    if (typeof (adapter as { render?: unknown }).render !== 'function') {
      throw new ProposalError(
        'adapter-cannot-render',
        String(type),
        'the adapter for this action type renders no wire bytes, so nothing can be approved',
      );
    }
    return adapter as ActionRenderer;
  }

  #record(proposalId: string): ProposalRecord {
    const record = this.#records.get(proposalId);
    if (record === undefined) {
      throw new ProposalError(
        'unknown-proposal',
        String(proposalId),
        'no proposal with this id exists',
      );
    }
    return record;
  }

  #latest(record: ProposalRecord): Revision {
    return record.revisions[record.revisions.length - 1]!;
  }
}

async function renderPayload(
  renderer: ActionRenderer,
  request: RenderRequest,
): Promise<Uint8Array> {
  const payload: unknown = await renderer.render(request);
  if (!(payload instanceof Uint8Array)) {
    throw new ProposalError(
      'invalid-payload',
      request.type,
      'render must return the wire bytes as a Uint8Array',
    );
  }
  return new Uint8Array(payload);
}

async function describeAttachments(
  attachments: readonly Attachment[],
): Promise<readonly AttachmentRecord[]> {
  const records: AttachmentRecord[] = [];
  for (const attachment of attachments) {
    records.push(
      Object.freeze({
        filename: attachment.filename,
        byteLength: attachment.bytes.length,
        sha256: await sha256Hex(attachment.bytes),
      }),
    );
  }
  return Object.freeze(records);
}

function checkTarget(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProposalError(
      'invalid-target',
      '$.target',
      'target must be a non-empty string naming where the action goes',
    );
  }
  return value;
}

function checkProposer(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProposalError(
      'invalid-proposer',
      '$.proposer',
      'proposer must be a non-empty string identifying who asked for the action',
    );
  }
  return value;
}

function checkDraft(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ProposalError(
      'invalid-draft',
      '$.draft',
      'draft must be a plain object the adapter can render',
    );
  }
  return value;
}

function checkAttachments(value: unknown): readonly Attachment[] {
  if (!Array.isArray(value)) {
    throw new ProposalError(
      'invalid-attachment',
      '$.attachments',
      'attachments must be an array, because their order is part of the digest',
    );
  }
  const copies: Attachment[] = [];
  let index = 0;
  for (const entry of value as unknown[]) {
    const path = `$.attachments[${String(index)}]`;
    if (!isPlainObject(entry)) {
      throw new ProposalError(
        'invalid-attachment',
        path,
        'an attachment must be an object holding filename and bytes',
      );
    }
    const filename = entry.filename;
    const bytes = entry.bytes;
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new ProposalError(
        'invalid-attachment',
        `${path}.filename`,
        'filename must be a non-empty string',
      );
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new ProposalError(
        'invalid-attachment',
        `${path}.bytes`,
        'bytes must be a Uint8Array of the attachment content',
      );
    }
    copies.push(Object.freeze({ filename, bytes: new Uint8Array(bytes) }));
    index += 1;
  }
  return Object.freeze(copies);
}

function checkWindow(value: unknown, maxWindowMs: number, path: string): ApprovalWindow {
  if (!isPlainObject(value)) {
    throw new ProposalError(
      'invalid-window',
      path,
      'window must be an object holding notBefore and notAfter',
    );
  }
  for (const key of Object.keys(value)) {
    if (key !== 'notBefore' && key !== 'notAfter') {
      throw new ProposalError(
        'invalid-window',
        `${path}.${key}`,
        'a window holds notBefore and notAfter only',
      );
    }
  }
  const notBefore = value.notBefore;
  const notAfter = value.notAfter;
  if (!isEpochMs(notBefore)) {
    throw new ProposalError(
      'invalid-window',
      `${path}.notBefore`,
      'notBefore must be a non-negative safe integer of epoch milliseconds',
    );
  }
  if (!isEpochMs(notAfter)) {
    throw new ProposalError(
      'invalid-window',
      `${path}.notAfter`,
      'notAfter must be a non-negative safe integer of epoch milliseconds',
    );
  }
  if (notAfter <= notBefore) {
    throw new ProposalError(
      'invalid-window',
      `${path}.notAfter`,
      'notAfter must be later than notBefore',
    );
  }
  if (notAfter - notBefore > maxWindowMs) {
    throw new ProposalError(
      'window-too-wide',
      path,
      `a window of ${String(notAfter - notBefore)} ms is wider than the ${String(maxWindowMs)} ms this action type allows`,
    );
  }
  return Object.freeze({ notBefore, notAfter });
}

function view(record: ProposalRecord): Proposal {
  return Object.freeze({
    id: record.id,
    type: record.type,
    target: record.target,
    proposer: record.proposer,
    revisions: Object.freeze([...record.revisions]),
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function isEpochMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}
