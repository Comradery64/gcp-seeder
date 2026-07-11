import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { seedProject } from '../src/seeder.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

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

const conflict = async () => {
  throw Object.assign(new Error('Requested entity already exists'), { code: 409 });
};

test('reconcile: an existing project + SA are reused, and no new key is minted', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });

  // Project create 409s; get returns the existing project number.
  const projectGet = mock.fn(async () => ({ data: { name: 'projects/555000' } }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { create: mock.fn(conflict), get: projectGet },
    operations: { get: async () => ({ data: { done: true } }) },
  }) as never);
  mock.method(google, 'serviceusage', () => ({
    services: { batchEnable: async () => ({ data: { name: 'operations/su1' } }) },
    operations: { get: async () => ({ data: { done: true } }) },
  }) as never);

  // SA create 409s; get returns the existing SA. Key create must NOT be called.
  const saGet = mock.fn(async () => ({ data: { name: 'projects/p/serviceAccounts/reader@p.iam.gserviceaccount.com', email: 'reader@p.iam.gserviceaccount.com', uniqueId: '42' } }));
  const keyCreate = mock.fn(async () => ({ data: { privateKeyData: Buffer.from('{}').toString('base64') } }));
  mock.method(google, 'iam', () => ({
    projects: { serviceAccounts: { create: mock.fn(conflict), get: saGet, keys: { create: keyCreate } } },
  }) as never);

  const res = await drain(
    seedProject({
      projectId: 'seed-reconcile-1',
      apis: [],
      credentials: { serviceAccount: false, oauthClient: false },
      serviceAccounts: [{ id: 'reader', displayName: 'reader', keyFile: 'reader-sa.json' }],
      reconcile: true,
      auth: {} as never,
      logger: () => {},
    }),
  );

  assert.equal(res.projectNumber, '555000', 'reused the existing project number');
  assert.equal(projectGet.mock.callCount(), 1);
  assert.equal(saGet.mock.callCount(), 1, 'looked up the existing SA');
  assert.equal(keyCreate.mock.callCount(), 0, 'must NOT mint a new key for an existing SA');
  assert.equal(res.serviceAccounts?.[0]?.email, 'reader@p.iam.gserviceaccount.com');
  assert.equal(res.serviceAccounts?.[0]?.keyFile, null);
  assert.equal(res.serviceAccounts?.[0]?.clientId, '42');
});

test('without reconcile, an existing project still throws (plain seed is unchanged)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { create: mock.fn(conflict), get: async () => ({ data: { name: 'projects/1' } }) },
    operations: { get: async () => ({ data: { done: true } }) },
  }) as never);

  await assert.rejects(
    drain(
      seedProject({
        projectId: 'seed-reconcile-2',
        apis: [],
        credentials: { serviceAccount: false, oauthClient: false },
        auth: {} as never,
        logger: () => {},
      }),
    ),
    /already exists/,
  );
});
