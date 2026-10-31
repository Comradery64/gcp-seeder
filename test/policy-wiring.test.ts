import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import { parseLabelArgs, validateUserLabels } from '../src/labels.js';
import { checkPolicy } from '../src/preflight.js';
import { assertNoViolations, loadOrgConfig, parseOrgConfig, resolveOrgConfigPath, resolvePolicy } from '../src/orgconfig.js';
import { getCallerEmail } from '../src/auth.js';
import { loadManifest, manifestToSeedOptions } from '../src/manifest.js';
import { seedProject } from '../src/seeder.js';
import { drainUntilSettled } from './helpers.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

test('parseLabelArgs parses key=value and rejects bad or reserved labels', () => {
  assert.deepEqual(parseLabelArgs(['cost-center=eng', 'team = platform']), { 'cost-center': 'eng', team: 'platform' });
  assert.deepEqual(parseLabelArgs(undefined), {});
  assert.throws(() => parseLabelArgs(['novalue']), /key=value/);
  assert.throws(() => parseLabelArgs(['Cost=eng']), /Invalid label key/);
  assert.throws(() => parseLabelArgs(['team=Platform Eng']), /Invalid value/);
  assert.throws(() => parseLabelArgs(['expires=2099-01-01']), /managed by gcp-seeder/);
  assert.throws(() => validateUserLabels({ 'seeded-by': 'me' }), /managed by gcp-seeder/);
});

test('checkPolicy: skip without config, pass when clean, fail listing every rule and fix', () => {
  assert.equal(checkPolicy(undefined).status, 'skip');
  assert.equal(checkPolicy([]).status, 'pass');
  const c = checkPolicy([
    { rule: 'ttl.max', detail: 'TTL 180d too long.', fix: 'Use --ttl 90d.' },
    { rule: 'keys', detail: 'Keys forbidden.', fix: 'Use --wif.' },
  ]);
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /ttl\.max.*keys/);
  assert.match(c.fix ?? '', /--ttl 90d.*--wif/);
});

test('resolvePolicy without a config only adds an explicit owner label; with one it enforces', () => {
  const none = resolvePolicy(undefined, { owner: 'jane@example.com', labels: { team: 'x' }, ttl: '365d' });
  assert.equal(none.violations, undefined);
  assert.deepEqual(none.resolved.labels, { team: 'x', owner: 'jane_at_example-com' });
  assert.equal(none.resolved.ttl, '365d');

  const cfg = parseOrgConfig({ version: 1, ttl: { max: '90d' }, owner: { domain: 'example.com' } });
  const withCfg = resolvePolicy(cfg, { owner: 'jane@example.com', ttl: '365d' });
  assert.equal(withCfg.resolved.labels?.owner, 'jane');
  assert.deepEqual(withCfg.violations?.map((v) => v.rule), ['ttl.max']);
});

test('assertNoViolations throws one message naming each rule and fix', () => {
  assert.doesNotThrow(() => assertNoViolations(undefined));
  assert.doesNotThrow(() => assertNoViolations([]));
  assert.throws(
    () => assertNoViolations([{ rule: 'keys', detail: 'Keys forbidden.', fix: 'Use --wif.' }]),
    /violates the org config[\s\S]*keys: Keys forbidden\. Fix: Use --wif\./,
  );
});

test('resolveOrgConfigPath: flag beats env, empty env is ignored', () => {
  assert.equal(resolveOrgConfigPath('a.yaml', { GCP_SEEDER_ORG_CONFIG: 'b.yaml' }), 'a.yaml');
  assert.equal(resolveOrgConfigPath(undefined, { GCP_SEEDER_ORG_CONFIG: 'b.yaml' }), 'b.yaml');
  assert.equal(resolveOrgConfigPath(undefined, { GCP_SEEDER_ORG_CONFIG: '' }), undefined);
});

test('loadOrgConfig reads YAML from disk and names the file on errors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seeder-orgcfg-'));
  try {
    const good = path.join(dir, 'gcp-seeder.org.yaml');
    await writeFile(good, 'version: 1\nttl:\n  max: 90d\n');
    assert.equal((await loadOrgConfig(good)).ttl?.max, '90d');
    const bad = path.join(dir, 'bad.yaml');
    await writeFile(bad, 'version: 1\nttll: {}\n');
    await assert.rejects(loadOrgConfig(bad), new RegExp(`Invalid ${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getCallerEmail: userinfo email, else impersonated target principal, else undefined', async () => {
  mock.method(google, 'oauth2', () => ({ userinfo: { get: async () => ({ data: { email: 'me@example.com' } }) } }) as never);
  assert.equal(await getCallerEmail({} as never), 'me@example.com');
  mock.restoreAll();

  mock.method(google, 'oauth2', () => ({ userinfo: { get: async () => { throw new Error('insufficient scope'); } } }) as never);
  assert.equal(await getCallerEmail({ targetPrincipal: 'tester@sandbox-proj.iam.gserviceaccount.com' } as never), 'tester@sandbox-proj.iam.gserviceaccount.com');
  assert.equal(await getCallerEmail({} as never), undefined);
});

test('manifest accepts owner + labels and passes labels through; rejects a bad owner', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seeder-manifest-'));
  try {
    const f = path.join(dir, 'gcp-seeder.yaml');
    await writeFile(f, 'projectId: seed-unit-m\nowner: jane@example.com\nlabels:\n  cost-center: eng\n');
    const m = await loadManifest(f);
    assert.equal(m.owner, 'jane@example.com');
    assert.deepEqual(manifestToSeedOptions(m).labels, { 'cost-center': 'eng' });
    await writeFile(f, 'projectId: seed-unit-m\nowner: not-an-email\n');
    await assert.rejects(loadManifest(f), /owner/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seedProject stamps user labels alongside the managed ones, and rejects reserved keys before any API call', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const create = mock.fn(async (_req: { requestBody: { labels: Record<string, string> } }) => ({ data: { name: 'operations/op1' } }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { create },
    operations: { get: async () => ({ data: { done: true, response: { name: 'projects/424242' } } }) },
  }) as never);
  mock.method(google, 'serviceusage', () => ({
    services: { batchEnable: async () => ({ data: { name: 'operations/su1' } }) },
    operations: { get: async () => ({ data: { done: true } }) },
  }) as never);

  const p = seedProject({
    projectId: 'seed-unit-labels',
    apis: [],
    wait: false,
    credentials: { serviceAccount: false, oauthClient: false },
    labels: { owner: 'jane', 'cost-center': 'eng' },
    ttl: '1d',
    auth: {} as never,
    logger: () => {},
  });
  await drainUntilSettled(p);
  const res = await p;
  const sent = create.mock.calls[0]!.arguments[0].requestBody.labels;
  assert.equal(sent.owner, 'jane');
  assert.equal(sent['cost-center'], 'eng');
  assert.equal(sent['seeded-by'], 'gcp-seeder');
  assert.ok(sent.expires);
  assert.equal(res.labels.owner, 'jane');

  create.mock.resetCalls();
  await assert.rejects(
    seedProject({
      projectId: 'seed-unit-labels',
      apis: [],
      credentials: { serviceAccount: false, oauthClient: false },
      labels: { 'seeded-by': 'someone-else' },
      auth: {} as never,
      logger: () => {},
    }),
    /managed by gcp-seeder/,
  );
  assert.equal(create.mock.callCount(), 0, 'no project is created when labels are invalid');
});
