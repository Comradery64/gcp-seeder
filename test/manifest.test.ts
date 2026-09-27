import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadManifest, manifestToSeedOptions } from '../src/manifest.js';

async function withTempManifest(body: string, fn: (p: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gcp-seeder-manifest-'));
  const file = path.join(dir, 'gcp-seeder.yaml');
  await writeFile(file, body, 'utf8');
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loadManifest parses a valid manifest', async () => {
  await withTempManifest(
    ['projectId: my-proj', 'displayName: My Proj', 'apis:', '  - run.googleapis.com', 'ttl: 30d'].join('\n'),
    async (file) => {
      const m = await loadManifest(file);
      assert.equal(m.projectId, 'my-proj');
      assert.deepEqual(m.apis, ['run.googleapis.com']);
      assert.equal(m.ttl, '30d');
    },
  );
});

test('loadManifest rejects unknown keys (typo protection)', async () => {
  await withTempManifest('projctId: oops\n', async (file) => {
    await assert.rejects(loadManifest(file), /Invalid manifest/);
  });
});

test('manifestToSeedOptions maps fields and turns on reconcile', () => {
  const opts = manifestToSeedOptions({ projectId: 'p', apis: ['a.googleapis.com'], serviceAccount: true, ttl: '2w' });
  assert.equal(opts.reconcile, true);
  assert.equal(opts.projectId, 'p');
  assert.equal(opts.credentials.serviceAccount, true);
  assert.equal(opts.ttl, '2w');
  assert.deepEqual(opts.apis, ['a.googleapis.com']);
});

test('manifestToSeedOptions expands a simple API preset (union with explicit apis)', () => {
  const opts = manifestToSeedOptions({ preset: 'ai', apis: ['extra.googleapis.com'] });
  assert.ok(opts.apis.includes('extra.googleapis.com'));
  assert.ok(opts.apis.length > 1, 'preset contributed APIs');
});

test('manifestToSeedOptions pulls SAs from a provisioning preset', () => {
  const opts = manifestToSeedOptions({ preset: 'directory-sync' });
  assert.ok((opts.serviceAccounts?.length ?? 0) >= 1, 'provisioning preset declares service accounts');
});

test('manifestToSeedOptions implies a service account when wif is set', () => {
  const opts = manifestToSeedOptions({ wif: 'github:acme/repo' });
  assert.equal(opts.credentials.serviceAccount, true, 'wif needs an SA to bind');
  assert.deepEqual(opts.wif, { provider: 'github', repo: 'acme/repo' });
});

test('manifestToSeedOptions rejects an unknown preset', () => {
  assert.throws(() => manifestToSeedOptions({ preset: 'nope' }), /Unknown preset/);
});

test('manifestToSeedOptions maps named service accounts with defaulted keyFile', () => {
  const opts = manifestToSeedOptions({ serviceAccounts: [{ id: 'reader', dwdScopes: ['scope-x'] }] });
  assert.equal(opts.serviceAccounts?.[0]?.id, 'reader');
  assert.equal(opts.serviceAccounts?.[0]?.keyFile, 'reader-sa.json');
  assert.deepEqual(opts.serviceAccounts?.[0]?.dwdScopes, ['scope-x']);
});

test('manifest: billingAccount, roles, harden, wait and budget map through (v0.5 keys)', async () => {
  await withTempManifest(
    [
      'projectId: my-app',
      'preset: ai',
      'serviceAccount: true',
      'billingAccount: 012345-ABCDEF-678901',
      'harden: true',
      'wait: false',
      'budget:',
      '  amountUsd: 25',
      '  killSwitch: true',
    ].join('\n'),
    async (file) => {
      const m = await loadManifest(file);
      const opts = manifestToSeedOptions(m);
      assert.equal(opts.billingAccount, '012345-ABCDEF-678901');
      assert.equal(opts.harden, true);
      assert.equal(opts.wait, false);
      assert.deepEqual(opts.budget, { amountUsd: 25, killSwitch: true });
      // The ai preset's least-privilege default applies when roles are not given.
      assert.deepEqual(opts.roles, ['roles/aiplatform.user']);
    },
  );
});

test('manifest: explicit roles override the preset default and basic roles are rejected', async () => {
  const opts = manifestToSeedOptions({ preset: 'ai', roles: ['roles/run.invoker'] });
  assert.deepEqual(opts.roles, ['roles/run.invoker']);
  assert.throws(() => manifestToSeedOptions({ roles: ['roles/editor'] }), /basic role/);
  await withTempManifest('budget:\n  amountUsd: -5\n', async (file) => {
    await assert.rejects(loadManifest(file), /Invalid manifest/);
  });
});
