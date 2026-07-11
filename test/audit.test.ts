import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { auditCloud } from '../src/audit.js';

function crmWith(projects: unknown[], listSpy?: ReturnType<typeof mock.fn>) {
  return { projects: { list: listSpy ?? (async () => ({ data: { projects } })) } };
}

// Fake IAM: every project has one SA; only gyb-project-abc's SA holds a key;
// listing SAs in seed-locked throws (simulates missing permission).
function fakeIam() {
  return {
    projects: {
      serviceAccounts: {
        list: async ({ name }: { name: string }) => {
          const pid = name.split('/')[1];
          if (pid === 'seed-locked') throw new Error('permission denied');
          return {
            data: {
              accounts: [
                {
                  name: `${name}/serviceAccounts/sa@${pid}.iam.gserviceaccount.com`,
                  email: `sa@${pid}.iam.gserviceaccount.com`,
                  uniqueId: `cid-${pid}`,
                },
              ],
            },
          };
        },
        keys: {
          list: async ({ name }: { name: string }) => ({
            data: {
              keys: name.includes('gyb-project-abc')
                ? [{ name: `${name}/keys/KEYAAA`, validAfterTime: '2026-01-01T00:00:00Z' }]
                : [],
            },
          }),
        },
      },
    },
  };
}

afterEach(() => mock.restoreAll());

test('flags orphans, finds static keys, builds DWD list, skips non-active, flags inaccessible', async () => {
  const projects = [
    { projectId: 'gyb-project-abc', projectNumber: '1', name: 'GYB', lifecycleState: 'ACTIVE' },
    { projectId: 'seed-xyz', projectNumber: '2', lifecycleState: 'ACTIVE' },
    { projectId: 'my-real-app', projectNumber: '3', lifecycleState: 'ACTIVE' },
    { projectId: 'gyb-project-old', projectNumber: '4', lifecycleState: 'DELETE_REQUESTED' },
    { projectId: 'seed-locked', projectNumber: '5', lifecycleState: 'ACTIVE' },
  ];
  mock.method(google, 'cloudresourcemanager', () => crmWith(projects) as never);
  mock.method(google, 'iam', () => fakeIam() as never);

  const r = await auditCloud({ auth: {} as never });

  assert.equal(r.scannedProjects, 5);

  const orphans = r.projects.filter((p) => p.orphanCandidate).map((p) => p.projectId).sort();
  assert.deepEqual(orphans, ['gyb-project-abc', 'gyb-project-old', 'seed-locked', 'seed-xyz']);
  assert.equal(r.projects.find((p) => p.projectId === 'my-real-app')!.orphanCandidate, false);

  // static keys: only gyb-project-abc's SA holds one
  assert.equal(r.staticKeys.length, 1);
  assert.equal(r.staticKeys[0]!.projectId, 'gyb-project-abc');
  assert.equal(r.staticKeys[0]!.keyId, 'KEYAAA');

  // DWD check-list: only SAs that actually have a key
  assert.equal(r.dwdCheckList.length, 1);
  assert.equal(r.dwdCheckList[0]!.clientId, 'cid-gyb-project-abc');

  // DELETE_REQUESTED project is listed but not scanned for SAs
  assert.equal(r.projects.find((p) => p.projectId === 'gyb-project-old')!.serviceAccounts.length, 0);

  // inaccessible project flagged + warned
  assert.equal(r.projects.find((p) => p.projectId === 'seed-locked')!.accessible, false);
  assert.ok(r.warnings.some((w) => w.includes('seed-locked')));
});

test('projectIds restricts the scan and skips the project listing', async () => {
  const listSpy = mock.fn(async () => ({ data: { projects: [] } }));
  mock.method(google, 'cloudresourcemanager', () => crmWith([], listSpy) as never);
  mock.method(google, 'iam', () => fakeIam() as never);

  const r = await auditCloud({ projectIds: ['seed-xyz'], auth: {} as never });

  assert.equal(r.scannedProjects, 1);
  assert.equal(listSpy.mock.callCount(), 0, 'must not list all projects when ids are given');
});

test('surfaces workload identity pools + providers (keyless-auth audit)', async () => {
  const projects = [{ projectId: 'seed-wif', projectNumber: '9', lifecycleState: 'ACTIVE' }];
  mock.method(google, 'cloudresourcemanager', () => crmWith(projects) as never);
  mock.method(google, 'iam', () => ({
    projects: {
      serviceAccounts: {
        list: async () => ({ data: { accounts: [] } }),
        keys: { list: async () => ({ data: { keys: [] } }) },
      },
      locations: {
        workloadIdentityPools: {
          list: async () => ({
            data: {
              workloadIdentityPools: [
                { name: 'projects/9/locations/global/workloadIdentityPools/gh-pool', displayName: 'GitHub Actions' },
              ],
            },
          }),
          providers: {
            list: async () => ({
              data: {
                workloadIdentityPoolProviders: [
                  {
                    name: 'projects/9/locations/global/workloadIdentityPools/gh-pool/providers/gh-acme-widgets',
                    oidc: { issuerUri: 'https://token.actions.githubusercontent.com' },
                    attributeCondition: "assertion.repository == 'acme/widgets'",
                  },
                ],
              },
            }),
          },
        },
      },
    },
  }) as never);

  const r = await auditCloud({ auth: {} as never });

  assert.equal(r.wifProviders.length, 1);
  assert.equal(r.wifProviders[0]!.projectId, 'seed-wif');
  assert.equal(r.wifProviders[0]!.poolId, 'gh-pool');
  assert.equal(r.wifProviders[0]!.providerId, 'gh-acme-widgets');
  assert.match(r.wifProviders[0]!.attributeCondition!, /acme\/widgets/);
  // Structured per-project view is populated too.
  assert.equal(r.projects[0]!.wifPools[0]!.providers.length, 1);
});

test('a WIF-less mock (no locations API) audits cleanly with no providers', async () => {
  const projects = [{ projectId: 'seed-xyz', lifecycleState: 'ACTIVE' }];
  mock.method(google, 'cloudresourcemanager', () => crmWith(projects) as never);
  mock.method(google, 'iam', () => fakeIam() as never); // fakeIam has no `locations`
  const r = await auditCloud({ auth: {} as never });
  assert.deepEqual(r.wifProviders, []);
  assert.deepEqual(r.projects[0]!.wifPools, []);
});

test('flags keys older than --max-key-age as stale', async () => {
  const projects = [{ projectId: 'gyb-project-abc', lifecycleState: 'ACTIVE' }];
  mock.method(google, 'cloudresourcemanager', () => crmWith(projects) as never);
  mock.method(google, 'iam', () => fakeIam() as never); // gyb-project-abc's SA holds a key created 2026-01-01

  const now = new Date('2026-07-10T00:00:00Z'); // ~190 days after 2026-01-01
  const r = await auditCloud({ maxKeyAge: '90d', now, auth: {} as never });

  assert.equal(r.staticKeys.length, 1);
  assert.ok(r.staticKeys[0]!.ageDays! >= 180, 'age is computed');
  assert.equal(r.staleKeys.length, 1, 'key older than 90d is stale');
  assert.equal(r.staleKeys[0]!.keyId, 'KEYAAA');

  // Without maxKeyAge, staleKeys stays empty even for old keys.
  const r2 = await auditCloud({ now, auth: {} as never });
  assert.deepEqual(r2.staleKeys, []);
});

test('claims label-owned projects even when the id matches no glob', async () => {
  const projects = [
    { projectId: 'custom-name-xyz', lifecycleState: 'ACTIVE', labels: { 'seeded-by': 'gcp-seeder', 'seeded-at': '2026-07-01' } },
    { projectId: 'other-app', lifecycleState: 'ACTIVE', labels: { team: 'core' } },
  ];
  mock.method(google, 'cloudresourcemanager', () => crmWith(projects) as never);
  mock.method(google, 'iam', () => fakeIam() as never);

  const r = await auditCloud({ auth: {} as never });

  const ours = r.projects.find((p) => p.projectId === 'custom-name-xyz')!;
  assert.equal(ours.orphanCandidate, true, 'label ownership overrides the glob miss');
  assert.equal(ours.labels?.['seeded-by'], 'gcp-seeder');
  // A project with unrelated labels is not claimed.
  assert.equal(r.projects.find((p) => p.projectId === 'other-app')!.orphanCandidate, false);
});

test('--project mode fetches each project so labels populate (label ownership works)', async () => {
  const get = mock.fn(async ({ projectId }: { projectId: string }) => ({
    data: { projectId, lifecycleState: 'ACTIVE', labels: { 'seeded-by': 'gcp-seeder', 'seeded-at': '2026-07-01' } },
  }));
  const listSpy = mock.fn(async () => ({ data: { projects: [] } }));
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { list: listSpy, get } }) as never);
  mock.method(google, 'iam', () => fakeIam() as never);

  const r = await auditCloud({ projectIds: ['custom-id-1'], auth: {} as never });

  assert.equal(listSpy.mock.callCount(), 0, 'must not list all projects when ids are given');
  assert.equal(get.mock.callCount(), 1, 'fetches the named project to populate labels');
  assert.equal(r.projects[0]!.labels?.['seeded-by'], 'gcp-seeder');
  assert.equal(r.projects[0]!.orphanCandidate, true, 'ownership recognized via label in --project mode');
});

test('custom flagPatterns override the defaults', async () => {
  const projects = [{ projectId: 'tmp-1', lifecycleState: 'ACTIVE' }, { projectId: 'keep-1', lifecycleState: 'ACTIVE' }];
  mock.method(google, 'cloudresourcemanager', () => crmWith(projects) as never);
  mock.method(google, 'iam', () => fakeIam() as never);

  const r = await auditCloud({ flagPatterns: ['tmp-*'], auth: {} as never });
  assert.equal(r.projects.find((p) => p.projectId === 'tmp-1')!.orphanCandidate, true);
  assert.equal(r.projects.find((p) => p.projectId === 'keep-1')!.orphanCandidate, false);
});
