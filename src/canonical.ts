const DOMAIN_LABEL = 'exactsend/v1\n';

const encoder = new TextEncoder();

// A surrogate without its partner: TextEncoder would emit U+FFFD for it, so two
// different strings would collapse onto one digest.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type CanonicalErrorCode =
  | 'NON_INTEGER_NUMBER'
  | 'UNSAFE_INTEGER'
  | 'UNDEFINED'
  | 'FUNCTION'
  | 'SYMBOL'
  | 'BIGINT'
  | 'DATE'
  | 'MAP'
  | 'SET'
  | 'CLASS_INSTANCE'
  | 'LONE_SURROGATE'
  | 'CIRCULAR_REFERENCE';

export class CanonicalError extends Error {
  readonly code: CanonicalErrorCode;
  readonly path: string;

  constructor(code: CanonicalErrorCode, path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'CanonicalError';
    this.code = code;
    this.path = path;
  }
}

export function canonicalBytes(value: unknown): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(DOMAIN_LABEL)];
  encodeValue(value, '$', parts, new Set<object>());
  return concat(parts);
}

export async function actionDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', canonicalBytes(value));
  return toHex(new Uint8Array(digest));
}

function encodeValue(
  value: unknown,
  path: string,
  parts: Uint8Array[],
  seen: Set<object>,
): void {
  if (value === null) {
    parts.push(encoder.encode('n'));
    return;
  }
  switch (typeof value) {
    case 'boolean':
      parts.push(encoder.encode(value ? 't' : 'f'));
      return;
    case 'number':
      encodeNumber(value, path, parts);
      return;
    case 'string':
      encodeString(value, path, parts);
      return;
    case 'object':
      encodeObject(value, path, parts, seen);
      return;
    case 'undefined':
      throw new CanonicalError('UNDEFINED', path, 'undefined has no canonical form');
    case 'function':
      throw new CanonicalError('FUNCTION', path, 'a function has no canonical form');
    case 'symbol':
      throw new CanonicalError('SYMBOL', path, 'a symbol has no canonical form');
    case 'bigint':
      throw new CanonicalError(
        'BIGINT',
        path,
        'bigint is not a canonical number; pass a decimal string',
      );
  }
}

function encodeNumber(value: number, path: string, parts: Uint8Array[]): void {
  if (!Number.isInteger(value)) {
    throw new CanonicalError(
      'NON_INTEGER_NUMBER',
      path,
      `${String(value)} is not an integer; pass amounts as strings or minor units`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalError(
      'UNSAFE_INTEGER',
      path,
      `${String(value)} is outside the safe integer range`,
    );
  }
  parts.push(encoder.encode(`i${String(value)}:`));
}

function encodeString(value: string, path: string, parts: Uint8Array[]): void {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalError(
      'LONE_SURROGATE',
      path,
      'string holds a lone surrogate, which UTF-8 encoding would replace with U+FFFD',
    );
  }
  const bytes = encoder.encode(value);
  parts.push(encoder.encode(`s${String(bytes.length)}:`), bytes);
}

function encodeObject(
  value: object,
  path: string,
  parts: Uint8Array[],
  seen: Set<object>,
): void {
  if (seen.has(value)) {
    throw new CanonicalError('CIRCULAR_REFERENCE', path, 'value contains itself');
  }
  if (value instanceof Date) {
    throw new CanonicalError(
      'DATE',
      path,
      'Date carries no canonical text; pass an explicit timestamp string',
    );
  }
  if (value instanceof Map) {
    throw new CanonicalError('MAP', path, 'Map has no canonical form; pass a plain object');
  }
  if (value instanceof Set) {
    throw new CanonicalError('SET', path, 'Set has no canonical form; pass an array');
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value as unknown[];
    parts.push(encoder.encode(`a${String(items.length)}:`));
    let index = 0;
    for (const item of items) {
      encodeValue(item, `${path}[${String(index)}]`, parts, seen);
      index += 1;
    }
  } else {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== null && proto !== Object.prototype) {
      const name =
        (proto as { constructor?: { name?: string } }).constructor?.name ?? 'anonymous';
      throw new CanonicalError(
        'CLASS_INSTANCE',
        path,
        `${name} instance is not a plain object`,
      );
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodeUnits);
    parts.push(encoder.encode(`o${String(keys.length)}:`));
    for (const key of keys) {
      encodeString(key, `${path} key ${JSON.stringify(key)}`, parts);
      encodeValue(record[key], `${path}.${key}`, parts, seen);
    }
  }
  seen.delete(value);
}

// Relational comparison of JS strings is already UTF-16 code unit order.
function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
