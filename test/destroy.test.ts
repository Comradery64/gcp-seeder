import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { destroyProjects } from '../src/destroy.js';

// A fake IAM client: one SA holding one user-managed key.
function fakeIam(keyDelete: ReturnType<typeof mock.fn>) {
  return {
    projects: {
      serviceAccounts: {
        list: async () => ({
          data: {
            accounts: [
              {
                name: 'projects/seed-test-x/serviceAccounts/sa@seed-test-x.iam.gserviceaccount.com',
                email: 'sa@seed-test-x.iam.gserviceaccount.com',
                uniqueId: '999',
              },
            ],
          },
        }),
        keys: {
          list: async () => ({
            data: { keys: [{ name: 'projects/seed-test-x/serviceAccounts/sa@x/keys/KEY123' }] },
          }),
          delete: keyDelete,
        },
      },
    },
  };
}

function stub(keyDelete: ReturnType<typeof mock.fn>, projDelete: ReturnType<typeof mock.fn>) {
  mock.method(google, 'iam', () => fakeIam(keyDelete) as never);
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { delete: projDelete } }) as never);
}

afterEach(() => mock.restoreAll());

test('keys-only revokes the static key but does NOT delete the project', async () => {
  const keyDelete = mock.fn(async () => ({ data: {} }));
  const projDelete = mock.fn(async () => ({ data: {} }));
  stub(keyDelete, projDelete);

  const res = await destroyProjects({
    projectIds: ['seed-test-x'],
    keysOnly: true,
    apply: true,
    auth: {} as never, // provided → resolveAuth returns it, no network
  });

  assert.equal(keyDelete.mock.callCount(), 1, 'the user-managed key is revoked');
  assert.equal(projDelete.mock.callCount(), 0, 'the project must NOT be deleted in keys-only mode');
  assert.deepEqual(res.projects[0]!.keysDeleted, ['sa@seed-test-x.iam.gserviceaccount.com:KEY123']);
  assert.equal(res.projects[0]!.projectDeleted, false);
});

test('full destroy revokes the key AND soft-deletes the project', async () => {
  const keyDelete = mock.fn(async () => ({ data: {} }));
  const projDelete = mock.fn(async () => ({ data: {} }));
  stub(keyDelete, projDelete);

  const res = await destroyProjects({ projectIds: ['seed-test-x'], apply: true, auth: {} as never });

  assert.equal(keyDelete.mock.callCount(), 1);
  assert.equal(projDelete.mock.callCount(), 1);
  assert.equal(res.projects[0]!.projectDeleted, true);
});

test('dry-run (no --apply) mutates nothing', async () => {
  const keyDelete = mock.fn(async () => ({ data: {} }));
  const projDelete = mock.fn(async () => ({ data: {} }));
  stub(keyDelete, projDelete);

  const res = await destroyProjects({ projectIds: ['seed-test-x'], auth: {} as never });

  assert.equal(keyDelete.mock.callCount(), 0);
  assert.equal(projDelete.mock.callCount(), 0);
  assert.equal(res.dryRun, true);
});

test('a non-orphan project is skipped without --force', async () => {
  const keyDelete = mock.fn(async () => ({ data: {} }));
  const projDelete = mock.fn(async () => ({ data: {} }));
  stub(keyDelete, projDelete);

  const res = await destroyProjects({ projectIds: ['prod-billing'], apply: true, auth: {} as never });

  assert.match(res.projects[0]!.skipped ?? '', /does not match an orphan pattern/);
  assert.equal(keyDelete.mock.callCount(), 0);
  assert.equal(projDelete.mock.callCount(), 0);
});
