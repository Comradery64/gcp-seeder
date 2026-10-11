import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrgPolicy, encodeOwnerLabel, parseOrgConfig, type OrgConfig } from '../src/orgconfig.js';

const LABEL_RE = /^[a-z0-9_-]{0,63}$/;

const full: OrgConfig = parseOrgConfig({
  version: 1,
  parents: { default: 'folders/111111111', allowed: ['folders/111111111', 'folders/222222222'] },
  billing: { account: '012345-ABCDEF-678901', required: true },
  budget: { defaultUsd: 50, maxUsd: 500 },
  ttl: { default: '30d', max: '90d', allowNone: false },
  labels: { required: ['owner', 'cost-center'] },
  owner: { required: true },
  harden: true,
  keys: 'forbid',
  apis: { denied: ['compute.googleapis.com'] },
});

test('encodeOwnerLabel produces a valid, readable label value', () => {
  assert.equal(encodeOwnerLabel('Jane.Doe@Example.com'), 'jane-doe_at_example-com');
  assert.equal(encodeOwnerLabel('ops+gcp@example.co.uk'), 'ops-gcp_at_example-co-uk');
  assert.match(encodeOwnerLabel('a.b@example.com'), LABEL_RE);
});

test('encodeOwnerLabel truncates long addresses to 63 chars with a stable, distinct hash', () => {
  const a = encodeOwnerLabel(`${'x'.repeat(70)}@example.com`);
  const b = encodeOwnerLabel(`${'x'.repeat(71)}@example.com`);
  assert.equal(a.length, 63);
  assert.match(a, LABEL_RE);
  assert.notEqual(a, b, 'different long addresses must not collide');
  assert.equal(a, encodeOwnerLabel(`${'X'.repeat(70)}@EXAMPLE.com`), 'case-insensitive and deterministic');
});

test('parseOrgConfig rejects unknown keys, bad parents and inconsistent defaults', () => {
  assert.throws(() => parseOrgConfig({ version: 1, budgte: {} }), /Unrecognized key|budgte/);
  assert.throws(() => parseOrgConfig({ version: 1, parents: { default: '123' } }), /folders\/<id>/);
  assert.throws(() => parseOrgConfig({ version: 1, parents: { default: 'folders/1', allowed: ['folders/2'] } }), /parents.default must be in/);
  assert.throws(() => parseOrgConfig({ version: 1, ttl: { default: '120d', max: '90d' } }), /ttl.default must not exceed/);
  assert.throws(() => parseOrgConfig({ version: 1, ttl: { max: '3 months' } }), /duration/);
  assert.throws(() => parseOrgConfig({ version: 2 }), /version/);
});

test('empty policy (version only) imposes nothing and changes nothing', () => {
  const req = { parent: 'organizations/1', ttl: '52w', apis: ['compute.googleapis.com'], wantsServiceAccountKey: true };
  const { resolved, violations } = applyOrgPolicy(parseOrgConfig({ version: 1 }), req);
  assert.deepEqual(violations, []);
  assert.equal(resolved.parent, 'organizations/1');
});

test('a compliant request gets defaults filled in and no violations', () => {
  const { resolved, violations } = applyOrgPolicy(full, { owner: 'jane@example.com', labels: { 'cost-center': 'eng' } });
  assert.deepEqual(violations, []);
  assert.equal(resolved.parent, 'folders/111111111');
  assert.equal(resolved.billingAccount, '012345-ABCDEF-678901');
  assert.equal(resolved.budgetUsd, 50);
  assert.equal(resolved.ttl, '30d');
  assert.equal(resolved.harden, true);
  assert.equal(resolved.labels?.owner, 'jane_at_example-com');
});

test('narrow-only: tightening is allowed, loosening is a violation per rule', () => {
  const ok = applyOrgPolicy(full, { owner: 'j@example.com', labels: { 'cost-center': 'eng' }, ttl: '7d', budgetUsd: 10 });
  assert.deepEqual(ok.violations, []);

  const bad = applyOrgPolicy(full, {
    parent: 'organizations/999',
    ttl: '180d',
    budgetUsd: 1000,
    harden: false,
    wantsServiceAccountKey: true,
    apis: ['compute.googleapis.com', 'iam.googleapis.com'],
  });
  const rules = bad.violations.map((x) => x.rule).sort();
  assert.deepEqual(rules, ['apis.denied', 'budget.maxUsd', 'harden', 'keys', 'labels.required', 'owner.required', 'parents.allowed', 'ttl.max']);
  assert.ok(bad.violations.every((x) => x.fix.length > 0), 'every violation carries a fix');
  const labelsV = bad.violations.find((x) => x.rule === 'labels.required')!;
  assert.match(labelsV.detail, /cost-center/);
  assert.doesNotMatch(labelsV.detail, /owner/, 'owner is reported once, under owner.required');
});

test('ttl.allowNone=false and billing.required catch missing values when no default exists', () => {
  const cfg = parseOrgConfig({ version: 1, ttl: { allowNone: false }, billing: { required: true } });
  const rules = applyOrgPolicy(cfg, {}).violations.map((x) => x.rule).sort();
  assert.deepEqual(rules, ['billing.required', 'ttl.allowNone']);
});
