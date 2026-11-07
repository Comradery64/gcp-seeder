import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertSeedHasIntent } from '../src/seedguard.js';

test('assertSeedHasIntent refuses a bare non-interactive seed', () => {
  assert.throws(() => assertSeedHasIntent({}, false), /Nothing to seed/);
});

test('assertSeedHasIntent allows the wizard and every documented non-interactive form', () => {
  assert.doesNotThrow(() => assertSeedHasIntent({}, true), 'interactive: the wizard asks');
  for (const opts of [
    { name: 'My App' },
    { projectId: 'my-proj' },
    { preset: 'ai' },
    { apis: 'gmail.googleapis.com' }, // README: --yes --apis …
    { serviceAccount: true },
    { serviceAccounts: 'reader' },
    { wif: 'github:owner/repo' }, // examples/sweep-github-actions.yml: --yes --wif …
    { oauthClient: true },
  ]) {
    assert.doesNotThrow(() => assertSeedHasIntent(opts, false), JSON.stringify(opts));
  }
});

test('the real CLI refuses bare `seed --yes` before any credential or network check', () => {
  // Isolated env with no credentials: if the guard didn't fire first, the run
  // would fail on credentials instead, with a different message.
  const home = mkdtempSync(path.join(tmpdir(), 'seeder-guard-'));
  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'seed', '--yes'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: home, CLOUDSDK_CONFIG: path.join(home, 'gcloud'), GOOGLE_APPLICATION_CREDENTIALS: path.join(home, 'none.json') },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Nothing to seed/);
    assert.doesNotMatch(r.stdout + r.stderr, /credentials found|Application Default Credentials/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
