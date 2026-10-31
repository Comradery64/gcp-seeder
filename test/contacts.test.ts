import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { ensureOwnerContact, ESSENTIAL_CONTACTS_API } from '../src/contacts.js';
import { seedProject } from '../src/seeder.js';
import { drainUntilSettled } from './helpers.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

type Req = { parent: string; headers?: Record<string, string>; requestBody?: { email: string; notificationCategorySubscriptions: string[] } };

function mockContacts(existing: string[] = [], createImpl?: () => Promise<unknown>) {
  const list = mock.fn(async (_r: Req) => ({ data: { contacts: existing.map((email) => ({ email })) } }));
  const create = mock.fn(createImpl ?? (async (_r: Req) => ({ data: {} })));
  mock.method(google, 'essentialcontacts', () => ({ projects: { contacts: { list, create } } }) as never);
  return { list, create };
}

test('ensureOwnerContact creates a TECHNICAL contact billed to the project itself', async () => {
  const { list, create } = mockContacts();
  const r = await ensureOwnerContact({} as never, 'seed-unit-ec', 'jane@example.com');
  assert.deepEqual(r, { email: 'jane@example.com', existed: false });
  const lreq = list.mock.calls[0]!.arguments[0];
  const creq = create.mock.calls[0]!.arguments[0] as Req;
  for (const req of [lreq, creq]) {
    assert.equal(req.parent, 'projects/seed-unit-ec');
    assert.equal(req.headers?.['x-goog-user-project'], 'seed-unit-ec', 'quota billed to the target project, not the caller');
  }
  assert.equal(creq.requestBody?.email, 'jane@example.com');
  assert.deepEqual(creq.requestBody?.notificationCategorySubscriptions, ['TECHNICAL']);
});

test('ensureOwnerContact is idempotent (case-insensitive)', async () => {
  const { create } = mockContacts(['Jane@Example.com']);
  const r = await ensureOwnerContact({} as never, 'seed-unit-ec', 'jane@example.com');
  assert.equal(r.existed, true);
  assert.equal(create.mock.callCount(), 0);
});

function mockSeedApis() {
  const batchEnable = mock.fn(async (_r: { requestBody: { serviceIds: string[] } }) => ({ data: { name: 'operations/su1' } }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { create: async () => ({ data: { name: 'operations/op1' } }) },
    operations: { get: async () => ({ data: { done: true, response: { name: 'projects/424242' } } }) },
  }) as never);
  mock.method(google, 'serviceusage', () => ({ services: { batchEnable }, operations: { get: async () => ({ data: { done: true } }) } }) as never);
  return { batchEnable };
}

const baseSeed = {
  projectId: 'seed-unit-ec',
  apis: [],
  wait: false,
  credentials: { serviceAccount: false, oauthClient: false },
  auth: {} as never,
  logger: () => {},
};

test('seed with ownerEmail enables Essential Contacts and records the owner', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { batchEnable } = mockSeedApis();
  const { create } = mockContacts();
  const p = seedProject({ ...baseSeed, ownerEmail: 'jane@example.com', labels: { owner: 'jane' } });
  await drainUntilSettled(p);
  const res = await p;
  const enabled = batchEnable.mock.calls.flatMap((c) => c.arguments[0].requestBody.serviceIds);
  assert.ok(enabled.includes(ESSENTIAL_CONTACTS_API));
  assert.equal(create.mock.callCount(), 1);
  assert.equal(res.ownerContact, 'jane@example.com');
  assert.deepEqual(res.warnings, []);
});

test('seed without ownerEmail neither enables Essential Contacts nor writes a contact', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { batchEnable } = mockSeedApis();
  const { create } = mockContacts();
  const p = seedProject({ ...baseSeed });
  await drainUntilSettled(p);
  const res = await p;
  assert.ok(!batchEnable.mock.calls.flatMap((c) => c.arguments[0].requestBody.serviceIds).includes(ESSENTIAL_CONTACTS_API));
  assert.equal(create.mock.callCount(), 0);
  assert.equal(res.ownerContact, undefined);
});

test('a failed contact write is a warning, not a failed seed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mockSeedApis();
  mockContacts([], async () => { throw Object.assign(new Error('Permission denied on resource'), { code: 403 }); });
  const p = seedProject({ ...baseSeed, ownerEmail: 'jane@example.com' });
  await drainUntilSettled(p);
  const res = await p;
  assert.equal(res.ownerContact, undefined);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0]!, /Essential Contact.*Permission denied.*owner label is still set/);
});
