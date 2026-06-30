import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
