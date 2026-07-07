import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import { seedProject, generateProjectId } from '../src/seeder.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

test('generateProjectId produces a valid GCP project id', () => {
  for (let i = 0; i < 25; i++) {
    const id = generateProjectId();
    assert.ok(id.length >= 6 && id.length <= 30, `length out of range: ${id}`);
    assert.match(id, /^[a-z][-a-z0-9]*[a-z0-9]$/, `invalid charset: ${id}`);
  }
});

test('rejects an invalid display name before any API call', async () => {
  await assert.rejects(
    seedProject({
      displayName: 'My App (delete me)', // parentheses are not allowed by GCP
      apis: [],
      credentials: { serviceAccount: false, oauthClient: false },
      auth: {} as never,
    }),
    /Invalid project display name/,
  );
});

test('requires supportEmail when creating an OAuth client', async () => {
  await assert.rejects(
    seedProject({
      projectId: 'seed-ok-name',
      apis: [],
      credentials: { serviceAccount: false, oauthClient: true },
      auth: {} as never,
    }),
    /supportEmail is required/,
  );
});

test('happy path: creates the project and enables the requested APIs', async () => {
  mock.timers.enable({ apis: ['setTimeout'] }); // skip the operation-poll sleeps
  const create = mock.fn(async () => ({ data: { name: 'operations/op1' } }));
  const crmGet = mock.fn(async () => ({ data: { done: true, response: { name: 'projects/424242' } } }));
  const batchEnable = mock.fn(async () => ({ data: { name: 'operations/su1' } }));
  const suGet = mock.fn(async () => ({ data: { done: true } }));
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { create }, operations: { get: crmGet } }) as never);
  mock.method(google, 'serviceusage', () => ({ services: { batchEnable }, operations: { get: suGet } }) as never);

  const promise = seedProject({
    projectId: 'seed-unit-1',
    apis: ['gmail.googleapis.com'],
    credentials: { serviceAccount: false, oauthClient: false },
    auth: {} as never,
    logger: () => {}, // keep test output quiet
  });
  // release the internal `await sleep(...)` calls as they get scheduled
  for (let i = 0; i < 60; i++) {
    mock.timers.runAll();
    await Promise.resolve();
  }
  const res = await promise;

  assert.equal(res.projectId, 'seed-unit-1');
  assert.equal(res.projectNumber, '424242');
  assert.ok(res.enabledApis.includes('gmail.googleapis.com'));
  assert.equal(create.mock.callCount(), 1);
  assert.ok(batchEnable.mock.callCount() >= 1);
  assert.equal(res.serviceAccount, undefined); // none requested
});

test('creates multiple named service accounts and surfaces DWD grants', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const create = mock.fn(async () => ({ data: { name: 'operations/op1' } }));
  const crmGet = mock.fn(async () => ({ data: { done: true, response: { name: 'projects/424242' } } }));
  const batchEnable = mock.fn(async () => ({ data: { name: 'operations/su1' } }));
  const suGet = mock.fn(async () => ({ data: { done: true } }));
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { create }, operations: { get: crmGet } }) as never);
  mock.method(google, 'serviceusage', () => ({ services: { batchEnable }, operations: { get: suGet } }) as never);

  // Each SA create returns a distinct email + uniqueId (the DWD client id).
  let n = 0;
  const saCreate = mock.fn(async () => {
    n += 1;
    return { data: { name: `projects/p/serviceAccounts/sa${n}`, email: `sa${n}@p.iam.gserviceaccount.com`, uniqueId: `10000000000000000000${n}` } };
  });
  const keyCreate = mock.fn(async () => ({ data: { privateKeyData: Buffer.from('{"type":"service_account"}').toString('base64') } }));
  mock.method(google, 'iam', () => ({ projects: { serviceAccounts: { create: saCreate, keys: { create: keyCreate } } } }) as never);

  const outputDir = await mkdtemp(path.join(tmpdir(), 'gcp-seeder-test-'));
  try {
    const scopes = ['https://www.googleapis.com/auth/admin.directory.user.readonly'];
    const promise = seedProject({
      projectId: 'seed-unit-2',
      apis: ['admin.googleapis.com'],
      credentials: { serviceAccount: false, oauthClient: false },
      serviceAccounts: [
        { id: 'reader-a', displayName: 'reader a', keyFile: 'reader-a-sa.json', dwdScopes: scopes },
        { id: 'reader-b', displayName: 'reader b', keyFile: 'reader-b-sa.json', dwdScopes: scopes },
      ],
      outputDir,
      auth: {} as never,
      logger: () => {},
    });
    for (let i = 0; i < 60; i++) {
      mock.timers.runAll();
      await Promise.resolve();
    }
    const res = await promise;

    assert.equal(saCreate.mock.callCount(), 2);
    assert.equal(res.serviceAccounts?.length, 2);
    // Legacy field points at the first SA.
    assert.equal(res.serviceAccount?.keyFile, path.join(outputDir, 'reader-a-sa.json'));
    // One DWD grant per SA, keyed on the SA's uniqueId.
    assert.equal(res.dwdGrants?.length, 2);
    assert.equal(res.dwdGrants?.[0]?.clientId, '100000000000000000001');
    assert.deepEqual(res.dwdGrants?.[0]?.scopes, scopes);
    // Both key files were actually written.
    const written = await readFile(path.join(outputDir, 'reader-b-sa.json'), 'utf8');
    assert.match(written, /service_account/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('org policy blocking SA key creation warns instead of throwing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const create = mock.fn(async () => ({ data: { name: 'operations/op1' } }));
  const crmGet = mock.fn(async () => ({ data: { done: true, response: { name: 'projects/424242' } } }));
  const batchEnable = mock.fn(async () => ({ data: { name: 'operations/su1' } }));
  const suGet = mock.fn(async () => ({ data: { done: true } }));
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { create }, operations: { get: crmGet } }) as never);
  mock.method(google, 'serviceusage', () => ({ services: { batchEnable }, operations: { get: suGet } }) as never);

  // SA creation succeeds, but the org forbids downloadable keys.
  const saCreate = mock.fn(async () => ({ data: { name: 'projects/p/serviceAccounts/sa1', email: 'sa1@p.iam.gserviceaccount.com', uniqueId: '111' } }));
  const keyCreate = mock.fn(async () => {
    throw new Error('Key creation is not allowed on this service account.');
  });
  mock.method(google, 'iam', () => ({ projects: { serviceAccounts: { create: saCreate, keys: { create: keyCreate } } } }) as never);

  const scopes = ['https://www.googleapis.com/auth/admin.directory.user.readonly'];
  const promise = seedProject({
    projectId: 'seed-unit-3',
    apis: ['admin.googleapis.com'],
    credentials: { serviceAccount: false, oauthClient: false },
    serviceAccounts: [{ id: 'directory-reader', displayName: 'reader', keyFile: 'reader-sa.json', dwdScopes: scopes }],
    outputDir: '/tmp/should-never-be-written',
    auth: {} as never,
    logger: () => {},
  });
  for (let i = 0; i < 60; i++) {
    mock.timers.runAll();
    await Promise.resolve();
  }
  const res = await promise; // must NOT throw

  // The SA is still surfaced (with its client id), just without a key file.
  assert.equal(res.serviceAccounts?.length, 1);
  assert.equal(res.serviceAccounts?.[0]?.keyFile, null);
  assert.equal(res.serviceAccounts?.[0]?.clientId, '111');
  // Legacy single-SA field stays undefined when no key was written.
  assert.equal(res.serviceAccount, undefined);
  // A DWD grant is still emitted — the client id is what matters for DWD.
  assert.equal(res.dwdGrants?.length, 1);
  // And a clear, actionable warning names the org policy.
  assert.ok(res.warnings.some((w) => /disableServiceAccountKeyCreation/.test(w)), 'expected org-policy warning');
});
