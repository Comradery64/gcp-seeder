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

// A fake IAM client with no SA keys but one WIF pool (one provider).
function fakeIamWithWif(poolDelete: ReturnType<typeof mock.fn>) {
  return {
    projects: {
      serviceAccounts: {
        list: async () => ({ data: { accounts: [] } }),
        keys: { list: async () => ({ data: { keys: [] } }), delete: mock.fn(async () => ({ data: {} })) },
      },
      locations: {
        workloadIdentityPools: {
          list: async () => ({
            data: { workloadIdentityPools: [{ name: 'projects/1/locations/global/workloadIdentityPools/gh-pool' }] },
          }),
          providers: {
            list: async () => ({
              data: {
                workloadIdentityPoolProviders: [
                  { name: 'projects/1/locations/global/workloadIdentityPools/gh-pool/providers/gh-x' },
                ],
              },
            }),
          },
          delete: poolDelete,
        },
      },
    },
  };
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

test('tears down WIF pools — even in keys-only mode (a standing credential)', async () => {
  const poolDelete = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'iam', () => fakeIamWithWif(poolDelete) as never);
  const projDelete = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { delete: projDelete } }) as never);

  const res = await destroyProjects({
    projectIds: ['seed-test-x'],
    keysOnly: true,
    apply: true,
    auth: {} as never,
  });

  assert.equal(poolDelete.mock.callCount(), 1, 'the WIF pool is torn down');
  assert.equal(projDelete.mock.callCount(), 0, 'keys-only must not delete the project');
  assert.deepEqual(res.projects[0]!.wifPoolsDeleted, ['gh-pool']);
});

test('dry-run lists WIF pools but deletes nothing', async () => {
  const poolDelete = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'iam', () => fakeIamWithWif(poolDelete) as never);
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { delete: mock.fn() } }) as never);

  const res = await destroyProjects({ projectIds: ['seed-test-x'], auth: {} as never });

  assert.equal(poolDelete.mock.callCount(), 0);
  assert.deepEqual(res.projects[0]!.wifPoolsDeleted, ['gh-pool']);
  assert.equal(res.dryRun, true);
});

test('acts on a label-owned project even when the id matches no glob (no --force)', async () => {
  const keyDelete = mock.fn(async () => ({ data: {} }));
  const projDelete = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'iam', () => fakeIam(keyDelete) as never);
  // crm.projects.get reports the seeder ownership label; no glob would match this id.
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: {
      get: async () => ({ data: { labels: { 'seeded-by': 'gcp-seeder' } } }),
      delete: projDelete,
    },
  }) as never);

  const res = await destroyProjects({ projectIds: ['custom-name-xyz'], apply: true, auth: {} as never });

  assert.equal(res.projects[0]!.skipped, undefined, 'label ownership passes the safety check');
  assert.equal(res.projects[0]!.matchedPattern, true);
  assert.equal(projDelete.mock.callCount(), 1);
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

// --- H: liens + --empty -----------------------------------------------------

function fakeIamNoKeys() {
  return {
    projects: {
      serviceAccounts: {
        list: async () => ({ data: { accounts: [] } }),
        keys: { list: async () => ({ data: { keys: [] } }), delete: mock.fn(async () => ({ data: {} })) },
      },
    },
  };
}

test('plan lists liens on a project (dry-run) without removing them', async () => {
  mock.method(google, 'iam', () => fakeIamNoKeys() as never);
  const lienList = mock.fn(async () => ({
    data: { liens: [{ name: 'liens/one', origin: 'compute.googleapis.com', reason: 'Shared VPC', restrictions: ['resourcemanager.projects.delete'] }] },
  }));
  const lienDelete = mock.fn(async () => ({ data: {} }));
  const projDelete = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { delete: projDelete },
    liens: { list: lienList, delete: lienDelete },
  }) as never);

  const res = await destroyProjects({ projectIds: ['seed-test-x'], auth: {} as never });

  assert.deepEqual(res.projects[0]!.liens.map((l) => l.name), ['liens/one']);
  assert.equal(lienDelete.mock.callCount(), 0, 'dry-run must not delete liens');
  assert.equal(projDelete.mock.callCount(), 0);
  assert.equal(res.dryRun, true);
});

test('apply skips a liened project (without --remove-liens) instead of failing the run', async () => {
  mock.method(google, 'iam', () => fakeIamNoKeys() as never);
  const lienList = mock.fn(async () => ({ data: { liens: [{ name: 'liens/one' }] } }));
  const lienDelete = mock.fn(async () => ({ data: {} }));
  const projDelete = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { delete: projDelete },
    liens: { list: lienList, delete: lienDelete },
  }) as never);

  const res = await destroyProjects({ projectIds: ['seed-test-x'], apply: true, auth: {} as never });

  assert.match(res.projects[0]!.skipped ?? '', /1 lien\(s\); re-run with --remove-liens/);
  assert.equal(lienDelete.mock.callCount(), 0);
  assert.equal(projDelete.mock.callCount(), 0, 'the project must NOT be deleted while liens block it');
  assert.equal(res.projects[0]!.projectDeleted, false);
});

test('apply with --remove-liens removes liens then deletes the project, in that order', async () => {
  mock.method(google, 'iam', () => fakeIamNoKeys() as never);
  const callOrder: string[] = [];
  const lienList = mock.fn(async () => ({ data: { liens: [{ name: 'liens/one' }, { name: 'liens/two' }] } }));
  const lienDelete = mock.fn(async () => {
    callOrder.push('lien-delete');
    return { data: {} };
  });
  const projDelete = mock.fn(async () => {
    callOrder.push('project-delete');
    return { data: {} };
  });
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { delete: projDelete },
    liens: { list: lienList, delete: lienDelete },
  }) as never);

  const res = await destroyProjects({
    projectIds: ['seed-test-x'],
    apply: true,
    removeLiens: true,
    auth: {} as never,
  });

  assert.deepEqual(res.projects[0]!.liensRemoved, ['liens/one', 'liens/two']);
  assert.equal(res.projects[0]!.projectDeleted, true);
  assert.equal(lienDelete.mock.callCount(), 2);
  assert.equal(projDelete.mock.callCount(), 1);
  assert.deepEqual(callOrder, ['lien-delete', 'lien-delete', 'project-delete']);
});

test('a 403 while listing liens is tolerated: liens report as empty, project still deletes', async () => {
  mock.method(google, 'iam', () => fakeIamNoKeys() as never);
  const lienList = mock.fn(async () => {
    throw Object.assign(new Error('forbidden'), { code: 403 });
  });
  const projDelete = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { delete: projDelete },
    liens: { list: lienList },
  }) as never);

  const res = await destroyProjects({ projectIds: ['seed-test-x'], apply: true, auth: {} as never });

  assert.deepEqual(res.projects[0]!.liens, []);
  assert.equal(projDelete.mock.callCount(), 1);
});

test('keysOnly and empty are mutually exclusive', async () => {
  await assert.rejects(
    destroyProjects({ projectIds: ['seed-test-x'], keysOnly: true, empty: true, auth: {} as never }),
    /mutually exclusive/,
  );
});

test('--empty deletes user-managed SAs, the gcp-seeder budget and non-bootstrap APIs, but never deletes the project', async () => {
  const saDelete = mock.fn(async () => ({ data: {} }));
  const keyDelete = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'iam', () => ({
    projects: {
      serviceAccounts: {
        list: async () => ({
          data: {
            accounts: [
              { name: 'projects/p/serviceAccounts/user@p.iam.gserviceaccount.com', email: 'user@p.iam.gserviceaccount.com', uniqueId: '1' },
              { name: 'projects/p/serviceAccounts/123-compute@developer.gserviceaccount.com', email: '123-compute@developer.gserviceaccount.com', uniqueId: '2' },
            ],
          },
        }),
        keys: { list: async () => ({ data: { keys: [] } }), delete: keyDelete },
        delete: saDelete,
      },
    },
  }) as never);
  const projDelete = mock.fn(async () => ({ data: {} }));
  const lienList = mock.fn(async () => ({ data: { liens: [] } }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { delete: projDelete },
    liens: { list: lienList },
  }) as never);

  const getBillingInfo = mock.fn(async () => ({ data: { billingAccountName: 'billingAccounts/ABC-123' } }));
  mock.method(google, 'cloudbilling', () => ({ projects: { getBillingInfo } }) as never);

  const budgetDelete = mock.fn(async () => ({ data: {} }));
  const budgetsList = mock.fn(async () => ({
    data: { budgets: [{ name: 'billingAccounts/ABC-123/budgets/b1', displayName: 'gcp-seeder:seed-test-x' }] },
  }));
  mock.method(google, 'billingbudgets', () => ({
    billingAccounts: { budgets: { list: budgetsList, delete: budgetDelete } },
  }) as never);

  mock.timers.enable({ apis: ['setTimeout'] });
  const servicesList = mock.fn(async () => ({
    data: {
      services: [
        { name: 'projects/p/services/cloudresourcemanager.googleapis.com', state: 'ENABLED' },
        { name: 'projects/p/services/aiplatform.googleapis.com', state: 'ENABLED' },
        { name: 'projects/p/services/sts.googleapis.com', state: 'ENABLED' },
      ],
    },
  }));
  const servicesDisable = mock.fn(async () => ({ data: { name: 'operations/su-disable-1' } }));
  const opGet = mock.fn(async () => ({ data: { done: true } }));
  mock.method(google, 'serviceusage', () => ({
    services: { list: servicesList, disable: servicesDisable },
    operations: { get: opGet },
  }) as never);

  const promise = destroyProjects({ projectIds: ['seed-test-x'], apply: true, empty: true, auth: {} as never });
  for (let i = 0; i < 20; i++) {
    mock.timers.runAll();
    await Promise.resolve();
  }
  const res = await promise;

  assert.equal(projDelete.mock.callCount(), 0, '--empty must never delete the project');
  assert.equal(res.projects[0]!.projectDeleted, false);
  assert.deepEqual(res.projects[0]!.serviceAccountsDeleted, ['user@p.iam.gserviceaccount.com']);
  assert.equal(saDelete.mock.callCount(), 1, 'only the user-managed SA is deleted, not the default compute SA');
  assert.equal(res.projects[0]!.budgetDeleted, true);
  assert.equal(budgetDelete.mock.callCount(), 1);
  assert.deepEqual(res.projects[0]!.apisDisabled, ['aiplatform.googleapis.com']);
  assert.equal(servicesDisable.mock.callCount(), 1, 'only the non-bootstrap, non-sts API is disabled');
});

test('--empty tolerates a 403 on the billing lookup and still reports (does not throw)', async () => {
  mock.method(google, 'iam', () => fakeIamNoKeys() as never);
  const projDelete = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { delete: projDelete },
    liens: { list: async () => ({ data: { liens: [] } }) },
  }) as never);
  const getBillingInfo = mock.fn(async () => {
    throw Object.assign(new Error('forbidden'), { code: 403 });
  });
  mock.method(google, 'cloudbilling', () => ({ projects: { getBillingInfo } }) as never);
  mock.method(google, 'billingbudgets', () => ({
    billingAccounts: { budgets: { list: mock.fn(), delete: mock.fn() } },
  }) as never);
  mock.method(google, 'serviceusage', () => ({
    services: { list: async () => ({ data: { services: [] } }), disable: mock.fn() },
    operations: { get: mock.fn() },
  }) as never);

  const res = await destroyProjects({ projectIds: ['seed-test-x'], apply: true, empty: true, auth: {} as never });

  assert.equal(res.projects[0]!.budgetDeleted, false);
  assert.equal(res.projects[0]!.projectDeleted, false);
});
