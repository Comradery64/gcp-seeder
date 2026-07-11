import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { sweepProjects } from '../src/sweep.js';

const NOW = new Date('2026-07-10T00:00:00Z');

// A representative fleet: expired, live, old-without-expiry, a glob-only legacy
// project, and one that isn't ours at all.
const PROJECTS = [
  { projectId: 'seed-expired', lifecycleState: 'ACTIVE', labels: { 'seeded-by': 'gcp-seeder', 'seeded-at': '2026-06-01', expires: '2026-07-01' } },
  { projectId: 'seed-live', lifecycleState: 'ACTIVE', labels: { 'seeded-by': 'gcp-seeder', 'seeded-at': '2026-07-05', expires: '2026-08-01' } },
  { projectId: 'seed-noexp', lifecycleState: 'ACTIVE', labels: { 'seeded-by': 'gcp-seeder', 'seeded-at': '2026-01-01' } },
  { projectId: 'gyb-project-old', lifecycleState: 'ACTIVE' }, // glob-only, no labels
  { projectId: 'my-real-app', lifecycleState: 'ACTIVE', labels: { team: 'core' } }, // not ours
];

function labelsFor(projectId: string): Record<string, string> | undefined {
  return PROJECTS.find((p) => p.projectId === projectId)?.labels;
}

function stub(projDelete: ReturnType<typeof mock.fn>) {
  // CRM v1: list (sweep) + get (destroy ownership check) + delete (destroy).
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: {
      list: async () => ({ data: { projects: PROJECTS } }),
      get: async ({ projectId }: { projectId: string }) => ({ data: { labels: labelsFor(projectId) } }),
      delete: projDelete,
    },
  }) as never);
  // IAM: destroy lists SAs (none here); no `locations` → listWifPools no-ops.
  mock.method(google, 'iam', () => ({
    projects: { serviceAccounts: { list: async () => ({ data: { accounts: [] } }) } },
  }) as never);
}

afterEach(() => mock.restoreAll());

test('dry-run selects only expired seeder-owned projects and deletes nothing', async () => {
  const projDelete = mock.fn(async () => ({ data: {} }));
  stub(projDelete);

  const r = await sweepProjects({ now: NOW, auth: {} as never });

  // Owned = 3 labeled + 1 glob-only; my-real-app excluded.
  assert.equal(r.scanned, 4);
  assert.ok(!r.candidates.some((c) => c.projectId === 'my-real-app'), 'non-owned project must be ignored');

  const selected = r.candidates.filter((c) => c.selected).map((c) => c.projectId);
  assert.deepEqual(selected, ['seed-expired']);

  assert.equal(r.dryRun, true);
  assert.equal(projDelete.mock.callCount(), 0, 'dry-run must not delete');
  assert.equal(r.destroy?.dryRun, true);

  // Ownership provenance is reported.
  assert.equal(r.candidates.find((c) => c.projectId === 'seed-expired')!.ownedBy, 'label');
  assert.equal(r.candidates.find((c) => c.projectId === 'gyb-project-old')!.ownedBy, 'glob');
});

test('--max-age also sweeps old projects without an expiry', async () => {
  const projDelete = mock.fn(async () => ({ data: {} }));
  stub(projDelete);

  const r = await sweepProjects({ maxAge: '30d', now: NOW, auth: {} as never });

  const selected = r.candidates.filter((c) => c.selected).map((c) => c.projectId).sort();
  // seed-expired (expired) + seed-noexp (191d old > 30d). seed-live is 5d old.
  assert.deepEqual(selected, ['seed-expired', 'seed-noexp']);
  assert.equal(r.candidates.find((c) => c.projectId === 'seed-noexp')!.stale, true);
  assert.equal(r.candidates.find((c) => c.projectId === 'seed-live')!.stale, false);
});

test('apply soft-deletes the selected projects', async () => {
  const projDelete = mock.fn(async () => ({ data: {} }));
  stub(projDelete);

  const r = await sweepProjects({ apply: true, now: NOW, auth: {} as never });

  assert.equal(r.dryRun, false);
  assert.equal(projDelete.mock.callCount(), 1, 'exactly the one expired project is deleted');
  assert.equal(r.destroy?.projects[0]!.projectId, 'seed-expired');
  assert.equal(r.destroy?.projects[0]!.projectDeleted, true);
});

test('nothing selected → no destroy call', async () => {
  const projDelete = mock.fn(async () => ({ data: {} }));
  // Only a live project this time.
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: {
      list: async () => ({ data: { projects: [PROJECTS[1]] } }), // seed-live only
      get: async () => ({ data: { labels: PROJECTS[1]!.labels } }),
      delete: projDelete,
    },
  }) as never);
  mock.method(google, 'iam', () => ({ projects: { serviceAccounts: { list: async () => ({ data: { accounts: [] } }) } } }) as never);

  const r = await sweepProjects({ apply: true, now: NOW, auth: {} as never });

  assert.equal(r.candidates.filter((c) => c.selected).length, 0);
  assert.equal(r.destroy, undefined);
  assert.equal(projDelete.mock.callCount(), 0);
});
