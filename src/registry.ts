const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.\-_][a-z0-9]+)*$/;

export type RegistryErrorCode =
  | 'duplicate-action-type'
  | 'invalid-action-type'
  | 'unknown-action-type'
  | 'invalid-overrides'
  | 'unknown-override-type'
  | 'unknown-override-key'
  | 'invalid-override-value'
  | 'reversible-not-overridable'
  | 'ttl-not-tightened'
  | 'role-not-registered'
  | 'batch-not-tightened';

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly path: string;

  constructor(code: RegistryErrorCode, path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'RegistryError';
    this.code = code;
    this.path = path;
  }
}

export interface ActionAdapter {
  send(action: Record<string, unknown>): Promise<unknown>;
}

export interface ActionTypeSpec {
  name: string;
  reversible: boolean;
  ttlMs: number;
  maxWindowMs: number;
  approverRoles: readonly string[];
  maxBatch: number;
  adapter: ActionAdapter;
}

export interface ActionType {
  readonly name: string;
  readonly reversible: boolean;
  readonly ttlMs: number;
  readonly maxWindowMs: number;
  readonly approverRoles: readonly string[];
  readonly maxBatch: number;
  readonly adapter: ActionAdapter;
}

export interface ActionPolicy {
  readonly name: string;
  readonly registered: boolean;
  readonly reversible: boolean;
  readonly approvalRequired: boolean;
  readonly executable: boolean;
  readonly ttlMs: number;
  readonly maxWindowMs: number;
  readonly approverRoles: readonly string[];
  readonly maxBatch: number;
}

const NO_ROLES: readonly string[] = Object.freeze([]);

export function defineActionType(spec: ActionTypeSpec): ActionType {
  const name = spec.name;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new RegistryError(
      'invalid-action-type',
      String(name),
      'name must be lowercase letters and digits, separated by . - or _',
    );
  }
  if (typeof spec.reversible !== 'boolean') {
    throw new RegistryError(
      'invalid-action-type',
      `${name}.reversible`,
      'reversible must be a boolean decided by the adapter',
    );
  }
  if (!isPositiveInteger(spec.ttlMs)) {
    throw new RegistryError(
      'invalid-action-type',
      `${name}.ttlMs`,
      'ttlMs must be a positive integer number of milliseconds',
    );
  }
  if (!isPositiveInteger(spec.maxWindowMs) || spec.maxWindowMs < spec.ttlMs) {
    throw new RegistryError(
      'invalid-action-type',
      `${name}.maxWindowMs`,
      'maxWindowMs must be a positive integer not shorter than ttlMs',
    );
  }
  if (!isRoleList(spec.approverRoles)) {
    throw new RegistryError(
      'invalid-action-type',
      `${name}.approverRoles`,
      'approverRoles must be a non-empty array of distinct role names',
    );
  }
  if (!isPositiveInteger(spec.maxBatch)) {
    throw new RegistryError(
      'invalid-action-type',
      `${name}.maxBatch`,
      'maxBatch must be a positive integer',
    );
  }
  const adapter: unknown = spec.adapter;
  if (
    adapter === null ||
    typeof adapter !== 'object' ||
    typeof (adapter as { send?: unknown }).send !== 'function'
  ) {
    throw new RegistryError(
      'invalid-action-type',
      `${name}.adapter`,
      'adapter must be an object with a send function',
    );
  }

  return Object.freeze({
    name,
    reversible: spec.reversible,
    ttlMs: spec.ttlMs,
    maxWindowMs: spec.maxWindowMs,
    approverRoles: Object.freeze([...spec.approverRoles]),
    maxBatch: spec.maxBatch,
    adapter: adapter as ActionAdapter,
  });
}

export class Registry {
  readonly #types = new Map<string, ActionType>();

  constructor(definitions: readonly ActionType[]) {
    for (const definition of definitions) {
      if (this.#types.has(definition.name)) {
        throw new RegistryError(
          'duplicate-action-type',
          definition.name,
          'an action type with this name is already registered',
        );
      }
      this.#types.set(definition.name, definition);
    }
  }

  names(): string[] {
    return [...this.#types.keys()].sort();
  }

  has(name: string): boolean {
    return this.#types.has(name);
  }

  policyFor(name: string): ActionPolicy {
    const type = this.#types.get(name);
    if (type === undefined) {
      return Object.freeze({
        name,
        registered: false,
        reversible: false,
        approvalRequired: true,
        executable: false,
        ttlMs: 0,
        maxWindowMs: 0,
        approverRoles: NO_ROLES,
        maxBatch: 0,
      });
    }
    return Object.freeze({
      name: type.name,
      registered: true,
      reversible: type.reversible,
      approvalRequired: true,
      executable: true,
      ttlMs: type.ttlMs,
      maxWindowMs: type.maxWindowMs,
      approverRoles: type.approverRoles,
      maxBatch: type.maxBatch,
    });
  }

  adapterFor(name: string): ActionAdapter {
    const type = this.#types.get(name);
    if (type === undefined) {
      throw new RegistryError(
        'unknown-action-type',
        name,
        'no code registers this action type, so it cannot execute',
      );
    }
    return type.adapter;
  }

  applyPolicyOverrides(overrides: unknown): Registry {
    if (!isPlainObject(overrides)) {
      throw new RegistryError(
        'invalid-overrides',
        '$',
        'overrides must be a JSON object keyed by registered action type',
      );
    }
    const next = new Map(this.#types);
    for (const [name, raw] of Object.entries(overrides)) {
      const current = this.#types.get(name);
      if (current === undefined) {
        throw new RegistryError(
          'unknown-override-type',
          `$.${name}`,
          'no action type with this name is registered in code',
        );
      }
      next.set(name, tighten(current, raw, `$.${name}`));
    }
    return new Registry([...next.values()]);
  }
}

function tighten(current: ActionType, raw: unknown, path: string): ActionType {
  if (!isPlainObject(raw)) {
    throw new RegistryError(
      'invalid-override-value',
      path,
      'an override must be an object holding ttlMs, approverRoles or maxBatch',
    );
  }

  let ttlMs = current.ttlMs;
  let approverRoles = current.approverRoles;
  let maxBatch = current.maxBatch;

  for (const key of Object.keys(raw)) {
    switch (key) {
      case 'ttlMs':
        ttlMs = tightenTtl(current, raw[key], `${path}.ttlMs`);
        break;
      case 'approverRoles':
        approverRoles = tightenRoles(current, raw[key], `${path}.approverRoles`);
        break;
      case 'maxBatch':
        maxBatch = tightenBatch(current, raw[key], `${path}.maxBatch`);
        break;
      case 'reversible':
        throw new RegistryError(
          'reversible-not-overridable',
          `${path}.reversible`,
          'reversibility follows from the adapter and cannot be configured',
        );
      default:
        throw new RegistryError(
          'unknown-override-key',
          `${path}.${key}`,
          'the override schema is closed: ttlMs, approverRoles and maxBatch only',
        );
    }
  }

  return Object.freeze({
    name: current.name,
    reversible: current.reversible,
    ttlMs,
    maxWindowMs: current.maxWindowMs,
    approverRoles,
    maxBatch,
    adapter: current.adapter,
  });
}

function tightenTtl(current: ActionType, value: unknown, path: string): number {
  if (!isPositiveInteger(value)) {
    throw new RegistryError(
      'invalid-override-value',
      path,
      'ttlMs must be a positive integer number of milliseconds',
    );
  }
  if (value > current.ttlMs) {
    throw new RegistryError(
      'ttl-not-tightened',
      path,
      `${String(value)} is longer than the registered ttl of ${String(current.ttlMs)}`,
    );
  }
  return value;
}

function tightenRoles(
  current: ActionType,
  value: unknown,
  path: string,
): readonly string[] {
  if (!isRoleList(value)) {
    throw new RegistryError(
      'invalid-override-value',
      path,
      'approverRoles must be a non-empty array of distinct role names',
    );
  }
  for (const role of value) {
    if (!current.approverRoles.includes(role)) {
      throw new RegistryError(
        'role-not-registered',
        path,
        `${role} is not an approver role registered for ${current.name}`,
      );
    }
  }
  const requested = new Set(value);
  return Object.freeze(current.approverRoles.filter((role) => requested.has(role)));
}

function tightenBatch(current: ActionType, value: unknown, path: string): number {
  if (!isPositiveInteger(value)) {
    throw new RegistryError(
      'invalid-override-value',
      path,
      'maxBatch must be a positive integer',
    );
  }
  if (value > current.maxBatch) {
    throw new RegistryError(
      'batch-not-tightened',
      path,
      `${String(value)} is larger than the registered batch of ${String(current.maxBatch)}`,
    );
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isRoleList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const roles = value as unknown[];
  if (roles.some((role) => typeof role !== 'string' || role.length === 0)) {
    return false;
  }
  return new Set(roles).size === roles.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}
