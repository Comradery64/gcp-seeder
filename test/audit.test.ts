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

test('custom flagPatterns override the defaults', async () => {
  const projects = [{ projectId: 'tmp-1', lifecycleState: 'ACTIVE' }, { projectId: 'keep-1', lifecycleState: 'ACTIVE' }];
  mock.method(google, 'cloudresourcemanager', () => crmWith(projects) as never);
  mock.method(google, 'iam', () => fakeIam() as never);

  const r = await auditCloud({ flagPatterns: ['tmp-*'], auth: {} as never });
  assert.equal(r.projects.find((p) => p.projectId === 'tmp-1')!.orphanCandidate, true);
  assert.equal(r.projects.find((p) => p.projectId === 'keep-1')!.orphanCandidate, false);
});
