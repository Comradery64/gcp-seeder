import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { seedProject } from '../src/seeder.js';
import { sweepProjects } from '../src/sweep.js';
import { rotateServiceAccountKey } from '../src/rotate.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

/** The property every command's --json mode relies on: the result is clean, lossless JSON. */
function assertRoundTrips(label: string, value: unknown) {
  const json = JSON.stringify(value);
  assert.doesNotThrow(() => JSON.parse(json), `${label}: must be valid JSON`);
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(value)), `${label}: round-trips losslessly`);
}

async function drain<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
  tracked.catch(() => {});
  for (let i = 0; i < 500 && !settled; i++) {
    mock.timers.runAll();
    await new Promise((r) => setImmediate(r));
  }
  return tracked;
}

test('SeedResult round-trips through JSON', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { create: async () => ({ data: { name: 'operations/op1' } }) },
    operations: { get: async () => ({ data: { done: true, response: { name: 'projects/424242' } } }) },
  }) as never);
  mock.method(google, 'serviceusage', () => ({
    services: { batchEnable: async () => ({ data: { name: 'operations/su1' } }) },
    operations: { get: async () => ({ data: { done: true } }) },
  }) as never);

  const res = await drain(seedProject({
    projectId: 'seed-json-1',
    apis: ['gmail.googleapis.com'],
    credentials: { serviceAccount: false, oauthClient: false },
    ttl: '7d',
    auth: {} as never,
    logger: () => {},
  }));

  assertRoundTrips('SeedResult', res);
  // The fields --json consumers depend on survive the trip.
  const parsed = JSON.parse(JSON.stringify(res));
  assert.equal(parsed.projectId, 'seed-json-1');
  assert.equal(parsed.labels['seeded-by'], 'gcp-seeder');
  assert.ok(parsed.labels.expires, 'ttl produced an expires label');
});

test('SweepResult round-trips through JSON (dry-run)', async () => {
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: {
      list: async () => ({ data: { projects: [{ projectId: 'seed-x', lifecycleState: 'ACTIVE', labels: { 'seeded-by': 'gcp-seeder', 'seeded-at': '2026-01-01' } }] } }),
      get: async () => ({ data: { labels: { 'seeded-by': 'gcp-seeder' } } }),
      delete: async () => ({ data: {} }),
    },
  }) as never);
  mock.method(google, 'iam', () => ({ projects: { serviceAccounts: { list: async () => ({ data: { accounts: [] } }) } } }) as never);

  const res = await sweepProjects({ maxAge: '30d', now: new Date('2026-07-10T00:00:00Z'), auth: {} as never });
  assertRoundTrips('SweepResult', res);
});

test('RotateResult round-trips through JSON (dry-run)', async () => {
  mock.method(google, 'iam', () => ({
    projects: { serviceAccounts: { keys: { list: async () => ({ data: { keys: [{ name: 'projects/p/serviceAccounts/sa/keys/K1' }] } }) } } },
  }) as never);

  const res = await rotateServiceAccountKey({ projectId: 'p', serviceAccountEmail: 'sa@p.iam.gserviceaccount.com', auth: {} as never });
  assertRoundTrips('RotateResult', res);
  assert.equal(JSON.parse(JSON.stringify(res)).dryRun, true);
});
