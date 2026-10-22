import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineActionType,
  Registry,
  RegistryError,
  type ActionAdapter,
  type ActionTypeSpec,
  type RegistryErrorCode,
} from '../src/index.ts';

const adapter: ActionAdapter = { send: async () => 'sent' };

function emailSendSpec(): ActionTypeSpec {
  return {
    name: 'email.send',
    reversible: false,
    ttlMs: 10 * 60_000,
    maxWindowMs: 60 * 60_000,
    approverRoles: ['ops-lead', 'finance'],
    maxBatch: 5,
    adapter,
  };
}

function registry(): Registry {
  return new Registry([defineActionType(emailSendSpec())]);
}

function refuses(code: RegistryErrorCode, run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RegistryError);
    assert.equal(error.code, code);
    return true;
  });
}

test('a registry is built only from code definitions', () => {
  const policy = registry().policyFor('email.send');
  assert.deepEqual(registry().names(), ['email.send']);
  assert.equal(policy.registered, true);
  assert.equal(policy.executable, true);
  assert.equal(policy.approvalRequired, true);
  assert.equal(policy.reversible, false);
  assert.equal(policy.ttlMs, 600_000);
  assert.equal(policy.maxWindowMs, 3_600_000);
  assert.equal(policy.maxBatch, 5);
  assert.deepEqual(policy.approverRoles, ['ops-lead', 'finance']);
});

test('a registered type resolves to its adapter', () => {
  assert.equal(registry().adapterFor('email.send'), adapter);
});

test('a duplicate name is refused', () => {
  refuses('duplicate-action-type', () => {
    const definition = defineActionType(emailSendSpec());
    return new Registry([definition, definition]);
  });
});

test('an unregistered name has no policy but its own worst case', () => {
  const policy = registry().policyFor('email.sned');
  assert.equal(policy.registered, false);
  assert.equal(policy.reversible, false);
  assert.equal(policy.approvalRequired, true);
  assert.equal(policy.executable, false);
  assert.equal(policy.ttlMs, 0);
  assert.equal(policy.maxWindowMs, 0);
  assert.equal(policy.maxBatch, 0);
  assert.deepEqual(policy.approverRoles, []);
});

test('an unregistered name cannot execute', () => {
  refuses('unknown-action-type', () => registry().adapterFor('email.sned'));
});

test('overrides may tighten ttl, roles and batch', () => {
  const base = registry();
  const tightened = base.applyPolicyOverrides({
    'email.send': { ttlMs: 60_000, approverRoles: ['finance'], maxBatch: 2 },
  });

  const policy = tightened.policyFor('email.send');
  assert.equal(policy.ttlMs, 60_000);
  assert.equal(policy.maxBatch, 2);
  assert.deepEqual(policy.approverRoles, ['finance']);
  assert.equal(policy.reversible, false);
  assert.equal(policy.maxWindowMs, 3_600_000);
  assert.equal(tightened.adapterFor('email.send'), adapter);

  const untouched = base.policyFor('email.send');
  assert.equal(untouched.ttlMs, 600_000);
  assert.equal(untouched.maxBatch, 5);
  assert.deepEqual(untouched.approverRoles, ['ops-lead', 'finance']);
});

test('a tightened role list keeps the order registered in code', () => {
  const tightened = registry().applyPolicyOverrides({
    'email.send': { approverRoles: ['finance', 'ops-lead'] },
  });
  assert.deepEqual(tightened.policyFor('email.send').approverRoles, ['ops-lead', 'finance']);
});

test('an empty override object leaves the policy as registered', () => {
  const tightened = registry().applyPolicyOverrides({ 'email.send': {} });
  assert.deepEqual(tightened.policyFor('email.send'), registry().policyFor('email.send'));
});

const overrideRefusals: Array<{
  label: string;
  code: RegistryErrorCode;
  value: unknown;
}> = [
  { label: 'overrides that are not an object', code: 'invalid-overrides', value: null },
  { label: 'overrides given as an array', code: 'invalid-overrides', value: [] },
  { label: 'overrides given as a string', code: 'invalid-overrides', value: '{}' },
  {
    label: 'an override for an unregistered type',
    code: 'unknown-override-type',
    value: { 'email.sned': { ttlMs: 1000 } },
  },
  {
    label: 'an override smuggled in through __proto__',
    code: 'unknown-override-type',
    value: JSON.parse('{"__proto__": {"ttlMs": 1000}}'),
  },
  {
    label: 'an override that is not an object',
    code: 'invalid-override-value',
    value: { 'email.send': 'tight' },
  },
  {
    label: 'a key outside the closed schema',
    code: 'unknown-override-key',
    value: { 'email.send': { maxWindowMs: 1000 } },
  },
  {
    label: 'a key naming a command',
    code: 'unknown-override-key',
    value: { 'email.send': { command: 'curl https://example.com' } },
  },
  {
    label: 'a key naming a module path',
    code: 'unknown-override-key',
    value: { 'email.send': { adapter: './adapters/evil.js' } },
  },
  {
    label: 'a reversible flag',
    code: 'reversible-not-overridable',
    value: { 'email.send': { reversible: true } },
  },
  {
    label: 'a longer ttl',
    code: 'ttl-not-tightened',
    value: { 'email.send': { ttlMs: 600_001 } },
  },
  {
    label: 'a ttl that is not a positive integer',
    code: 'invalid-override-value',
    value: { 'email.send': { ttlMs: 0 } },
  },
  {
    label: 'a fractional ttl',
    code: 'invalid-override-value',
    value: { 'email.send': { ttlMs: 1500.5 } },
  },
  {
    label: 'a ttl given as a string',
    code: 'invalid-override-value',
    value: { 'email.send': { ttlMs: '60000' } },
  },
  {
    label: 'an added approver role',
    code: 'role-not-registered',
    value: { 'email.send': { approverRoles: ['ops-lead', 'legal'] } },
  },
  {
    label: 'an empty approver role list',
    code: 'invalid-override-value',
    value: { 'email.send': { approverRoles: [] } },
  },
  {
    label: 'an approver role that is not a string',
    code: 'invalid-override-value',
    value: { 'email.send': { approverRoles: ['ops-lead', 3] } },
  },
  {
    label: 'a larger batch',
    code: 'batch-not-tightened',
    value: { 'email.send': { maxBatch: 50 } },
  },
  {
    label: 'a batch below one',
    code: 'invalid-override-value',
    value: { 'email.send': { maxBatch: 0 } },
  },
];

for (const { label, code, value } of overrideRefusals) {
  test(`refuses ${label} with code ${code}`, () => {
    refuses(code, () => registry().applyPolicyOverrides(value));
  });
}

const definitionRefusals: Array<{ label: string; patch: Partial<ActionTypeSpec> }> = [
  { label: 'an empty name', patch: { name: '' } },
  { label: 'a name with uppercase letters', patch: { name: 'Email.Send' } },
  { label: 'a name with a path separator', patch: { name: 'email/send' } },
  { label: 'a ttl of zero', patch: { ttlMs: 0 } },
  { label: 'a fractional ttl', patch: { ttlMs: 1.5 } },
  { label: 'a window shorter than the ttl', patch: { maxWindowMs: 1000 } },
  { label: 'no approver role', patch: { approverRoles: [] } },
  { label: 'a repeated approver role', patch: { approverRoles: ['ops-lead', 'ops-lead'] } },
  { label: 'a batch of zero', patch: { maxBatch: 0 } },
  { label: 'an adapter without send', patch: { adapter: {} as ActionAdapter } },
];

for (const { label, patch } of definitionRefusals) {
  test(`refuses a definition with ${label}`, () => {
    refuses('invalid-action-type', () => defineActionType({ ...emailSendSpec(), ...patch }));
  });
}
