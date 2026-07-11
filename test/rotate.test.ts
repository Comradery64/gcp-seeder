import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import { rotateServiceAccountKey } from '../src/rotate.js';

const SA = 'ci@proj.iam.gserviceaccount.com';
const OLD1 = `projects/proj/serviceAccounts/${SA}/keys/OLDKEY0001`;
const OLD2 = `projects/proj/serviceAccounts/${SA}/keys/OLDKEY0002`;

function iamMock(spies: {
  list: ReturnType<typeof mock.fn>;
  create?: ReturnType<typeof mock.fn>;
  disable?: ReturnType<typeof mock.fn>;
  del?: ReturnType<typeof mock.fn>;
}) {
  return {
    projects: {
      serviceAccounts: {
        keys: {
          list: spies.list,
          create: spies.create ?? mock.fn(),
          disable: spies.disable ?? mock.fn(async () => ({ data: {} })),
          delete: spies.del ?? mock.fn(async () => ({ data: {} })),
        },
      },
    },
  };
}

afterEach(() => mock.restoreAll());

test('dry-run lists the keys to retire and mutates nothing', async () => {
  const list = mock.fn(async () => ({ data: { keys: [{ name: OLD1 }, { name: OLD2 }] } }));
  const create = mock.fn();
  const disable = mock.fn();
  const del = mock.fn();
  mock.method(google, 'iam', () => iamMock({ list, create, disable, del }) as never);

  const r = await rotateServiceAccountKey({ projectId: 'proj', serviceAccountEmail: SA, auth: {} as never });

  assert.equal(r.dryRun, true);
  assert.deepEqual(r.retiredKeyIds.sort(), ['OLDKEY0001', 'OLDKEY0002']);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(disable.mock.callCount(), 0);
  assert.equal(del.mock.callCount(), 0);
  assert.equal(r.newKeyId, undefined);
});

test('apply mints a new key, writes it, then disables + deletes the old ones', async () => {
  const list = mock.fn(async () => ({ data: { keys: [{ name: OLD1 }, { name: OLD2 }] } }));
  const create = mock.fn(async () => ({
    data: {
      name: `projects/proj/serviceAccounts/${SA}/keys/NEWKEY123456`,
      privateKeyData: Buffer.from('{"type":"service_account"}').toString('base64'),
    },
  }));
  const disable = mock.fn(async () => ({ data: {} }));
  const del = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'iam', () => iamMock({ list, create, disable, del }) as never);

  const outputDir = await mkdtemp(path.join(tmpdir(), 'gcp-seeder-rotate-'));
  try {
    const r = await rotateServiceAccountKey({
      projectId: 'proj',
      serviceAccountEmail: SA,
      outputDir,
      apply: true,
      auth: {} as never,
      logger: () => {},
    });

    assert.equal(r.dryRun, false);
    assert.equal(create.mock.callCount(), 1);
    assert.equal(r.newKeyId, 'NEWKEY123456');
    // Two-phase: every retired key is disabled AND deleted.
    assert.equal(disable.mock.callCount(), 2);
    assert.equal(del.mock.callCount(), 2);
    assert.deepEqual(r.retiredKeyIds.sort(), ['OLDKEY0001', 'OLDKEY0002']);
    // The new key was actually written with the expected name.
    const written = await readFile(r.newKeyFile!, 'utf8');
    assert.match(written, /service_account/);
    assert.match(r.newKeyFile!, /ci-NEWKEY12\.json$/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('--key-id retires only the named key', async () => {
  const list = mock.fn(async () => ({ data: { keys: [{ name: OLD1 }, { name: OLD2 }] } }));
  const create = mock.fn(async () => ({
    data: { name: `projects/proj/serviceAccounts/${SA}/keys/NEWKEY999`, privateKeyData: Buffer.from('{}').toString('base64') },
  }));
  const del = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'iam', () => iamMock({ list, create, del }) as never);

  const outputDir = await mkdtemp(path.join(tmpdir(), 'gcp-seeder-rotate-'));
  try {
    const r = await rotateServiceAccountKey({
      projectId: 'proj',
      serviceAccountEmail: SA,
      keyId: 'OLDKEY0002',
      outputDir,
      apply: true,
      auth: {} as never,
      logger: () => {},
    });
    assert.deepEqual(r.retiredKeyIds, ['OLDKEY0002']);
    assert.equal(del.mock.callCount(), 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('org policy blocking key creation leaves old keys untouched and warns', async () => {
  const list = mock.fn(async () => ({ data: { keys: [{ name: OLD1 }] } }));
  const create = mock.fn(async () => {
    throw new Error('Key creation is not allowed on this service account.');
  });
  const disable = mock.fn();
  const del = mock.fn();
  mock.method(google, 'iam', () => iamMock({ list, create, disable, del }) as never);

  const r = await rotateServiceAccountKey({
    projectId: 'proj',
    serviceAccountEmail: SA,
    apply: true,
    auth: {} as never,
    logger: () => {},
  });

  assert.equal(r.newKeyId, undefined);
  assert.equal(disable.mock.callCount(), 0, 'old key must NOT be retired if the new one could not be minted');
  assert.equal(del.mock.callCount(), 0);
  assert.ok(r.warnings.some((w) => /disableServiceAccountKeyCreation/.test(w)));
  assert.ok(r.warnings.some((w) => /--wif/.test(w)));
});

test('rotating a specific key that does not exist throws', async () => {
  const list = mock.fn(async () => ({ data: { keys: [{ name: OLD1 }] } }));
  mock.method(google, 'iam', () => iamMock({ list }) as never);

  await assert.rejects(
    rotateServiceAccountKey({ projectId: 'proj', serviceAccountEmail: SA, keyId: 'NOPE', auth: {} as never }),
    /No user-managed key NOPE/,
  );
});
