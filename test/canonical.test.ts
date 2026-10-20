import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionDigest,
  canonicalBytes,
  CanonicalError,
  type CanonicalErrorCode,
} from '../src/index.ts';

const DOMAIN_LABEL = 'exactsend/v1\n';

test('canonical bytes open with the domain label', () => {
  const bytes = canonicalBytes({ to: 'ops@example.com' });
  const prefix = new TextDecoder().decode(bytes.subarray(0, DOMAIN_LABEL.length));
  assert.equal(prefix, DOMAIN_LABEL);
});

test('digest is 64 lowercase hex characters', async () => {
  assert.match(await actionDigest({ attempts: 1 }), /^[0-9a-f]{64}$/);
});

test('key order does not change the digest', async () => {
  const a = await actionDigest({ to: 'ops@example.com', minorUnits: 1200, memo: 'rent' });
  const b = await actionDigest({ memo: 'rent', to: 'ops@example.com', minorUnits: 1200 });
  assert.equal(a, b);
});

test('nested key order does not change the digest', async () => {
  const a = await actionDigest({ body: { subject: 'Invoice 41', cc: ['a', 'b'] } });
  const b = await actionDigest({ body: { cc: ['a', 'b'], subject: 'Invoice 41' } });
  assert.equal(a, b);
});

test('array order does change the digest', async () => {
  const a = await actionDigest(['a', 'b']);
  const b = await actionDigest(['b', 'a']);
  assert.notEqual(a, b);
});

test('NFC and NFD text give different digests', async () => {
  const nfc = await actionDigest({ name: 'caf\u00e9' });
  const nfd = await actionDigest({ name: 'cafe\u0301' });
  assert.notEqual(nfc, nfd);
});

test('keys and values cannot be shifted into each other', async () => {
  const a = await actionDigest({ ab: '' });
  const b = await actionDigest({ a: 'b' });
  assert.notEqual(a, b);
});

test('a well-formed surrogate pair is accepted', async () => {
  assert.match(await actionDigest({ note: '\uD83D\uDE80' }), /^[0-9a-f]{64}$/);
});

class Order {
  id = 'a1';
}

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

const refusals: Array<{ label: string; value: unknown; code: CanonicalErrorCode }> = [
  { label: 'a float', value: { amount: 12.5 }, code: 'NON_INTEGER_NUMBER' },
  { label: 'NaN', value: Number.NaN, code: 'NON_INTEGER_NUMBER' },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY, code: 'NON_INTEGER_NUMBER' },
  { label: 'an integer beyond 2^53 - 1', value: 2 ** 53, code: 'UNSAFE_INTEGER' },
  { label: 'undefined', value: { memo: undefined }, code: 'UNDEFINED' },
  { label: 'a function', value: { retry: () => 1 }, code: 'FUNCTION' },
  { label: 'a symbol', value: Symbol('draft'), code: 'SYMBOL' },
  { label: 'a bigint', value: 1n, code: 'BIGINT' },
  { label: 'a Date', value: { at: new Date(0) }, code: 'DATE' },
  { label: 'a Map', value: new Map([['a', 1]]), code: 'MAP' },
  { label: 'a Set', value: new Set(['a']), code: 'SET' },
  { label: 'a class instance', value: new Order(), code: 'CLASS_INSTANCE' },
  { label: 'a high lone surrogate', value: 'a\uD800b', code: 'LONE_SURROGATE' },
  { label: 'a low lone surrogate', value: { note: '\uDC00' }, code: 'LONE_SURROGATE' },
  { label: 'a lone surrogate in a key', value: { '\uD83D': 1 }, code: 'LONE_SURROGATE' },
  { label: 'a cycle', value: cyclic, code: 'CIRCULAR_REFERENCE' },
];

for (const { label, value, code } of refusals) {
  test(`refuses ${label} with code ${code}`, () => {
    assert.throws(
      () => canonicalBytes(value),
      (error: unknown) => {
        assert.ok(error instanceof CanonicalError);
        assert.equal(error.code, code);
        return true;
      },
    );
  });
}

test('a repeated object is not mistaken for a cycle', async () => {
  const shared = { id: 'a1' };
  assert.match(await actionDigest({ first: shared, second: shared }), /^[0-9a-f]{64}$/);
});
