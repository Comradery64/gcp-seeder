import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { preflight, BILLING_REQUIRED_APIS } from '../src/preflight.js';

afterEach(() => mock.restoreAll());

function findCheck(checks: { id: string }[], id: string) {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `expected a "${id}" check`);
  return c!;
}

/**
 * `src/preflight.ts` imports `resolveBillingAccount`/`canLinkProjects` from
 * `./billing.js` as named ESM bindings, which `mock.method` cannot redefine
 * (module namespace properties are non-configurable). So billing behavior is
 * driven the same way the rest of this suite drives everything else: through
 * the underlying `google.cloudbilling` client the stub billing.ts calls.
 */
function cloudbillingApi(overrides: {
  accounts?: Array<{ name: string; displayName?: string; open?: boolean }>;
  list?: () => Promise<unknown>;
  testIamPermissions?: (params: unknown) => Promise<unknown>;
} = {}) {
  return {
    billingAccounts: {
      list:
        overrides.list ??
        (async () => ({ data: { billingAccounts: overrides.accounts ?? [] } })),
      testIamPermissions:
        overrides.testIamPermissions ?? (async () => ({ data: { permissions: [] } })),
    },
  };
}

/** Minimal fakes for every API preflight touches, all defaulting to happy/empty responses. */
function baseMocks(overrides: {
  oauth2?: unknown;
  crm?: unknown;
  orgpolicy?: unknown;
  serviceusage?: unknown;
  cloudbilling?: unknown;
} = {}) {
  mock.method(
    google,
    'oauth2',
    () => overrides.oauth2 ?? { userinfo: { get: async () => ({ data: { email: 'me@example.com' } }) } } as never,
  );
  mock.method(
    google,
    'cloudresourcemanager',
    () =>
      overrides.crm ??
      ({
        projects: { search: async () => ({ data: { projects: [] } }) },
        folders: { testIamPermissions: async () => ({ data: { permissions: ['resourcemanager.projects.create'] } }) },
        organizations: { testIamPermissions: async () => ({ data: { permissions: ['resourcemanager.projects.create'] } }) },
      } as never),
  );
  mock.method(google, 'orgpolicy', () => overrides.orgpolicy ?? emptyOrgPolicy() as never);
  mock.method(
    google,
    'serviceusage',
    () => overrides.serviceusage ?? { services: { get: async () => ({ data: { state: 'ENABLED' } }) } } as never,
  );
  mock.method(google, 'cloudbilling', () => overrides.cloudbilling ?? cloudbillingApi() as never);
}

function emptyOrgPolicy(enforced: string[] = []) {
  const getEffectivePolicy = async ({ name }: { name: string }) => {
    const constraint = name.split('/policies/')[1]!;
    return { data: { spec: { rules: enforced.includes(constraint) ? [{ enforce: true }] : [] } } };
  };
  return {
    folders: { policies: { getEffectivePolicy } },
    organizations: { policies: { getEffectivePolicy } },
  };
}

test('BILLING_REQUIRED_APIS contains the documented set', () => {
  assert.ok(BILLING_REQUIRED_APIS.has('aiplatform.googleapis.com'));
  assert.ok(BILLING_REQUIRED_APIS.has('run.googleapis.com'));
  assert.ok(BILLING_REQUIRED_APIS.has('compute.googleapis.com'));
  assert.ok(!BILLING_REQUIRED_APIS.has('iam.googleapis.com'));
});

test('all-pass baseline: every check reports pass or skip, report is ok', async () => {
  baseMocks();

  const r = await preflight({ auth: {} as never });

  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 7);
  assert.ok(!r.checks.some((c) => c.status === 'fail'));
  assert.equal(findCheck(r.checks, 'auth').status, 'pass');
  assert.match(findCheck(r.checks, 'auth').detail, /me@example\.com/);
  assert.equal(findCheck(r.checks, 'project-id').status, 'skip');
  assert.equal(findCheck(r.checks, 'parent').status, 'skip');
  assert.equal(findCheck(r.checks, 'billing').status, 'pass'); // no apis requested
  assert.equal(findCheck(r.checks, 'org-policy').status, 'skip'); // no parent given
  assert.equal(findCheck(r.checks, 'bootstrap-apis').status, 'skip'); // no quota project on {}
});

test('auth check skips (not throws) when the principal cannot be determined', async () => {
  baseMocks({ oauth2: { userinfo: { get: async () => { throw new Error('insufficient scope'); } } } });

  const r = await preflight({ auth: {} as never });

  const check = findCheck(r.checks, 'auth');
  assert.equal(check.status, 'skip');
  assert.match(check.detail, /insufficient scope/);
  // must not throw, and must not affect other checks / overall ok
  assert.equal(r.ok, true);
});

test('preflight() never throws when resolveAuth itself fails; every check is skip', async () => {
  // No auth injected and ADC is blocked by test/setup.ts, so resolveAuth rejects.
  const r = await preflight({});
  assert.equal(r.checks.length, 7);
  assert.ok(r.checks.every((c) => c.status === 'skip'));
  assert.equal(r.ok, true);
});

test('project-id: fail on invalid shape (rejected by regex before any project-id-specific search)', async () => {
  // `quota` also calls crm.projects.search concurrently, so this only checks
  // the project-id check's own outcome, not call counts on the shared client.
  baseMocks({ crm: { projects: { search: async () => ({ data: { projects: [] } }) } } });

  const r = await preflight({ auth: {} as never, projectId: 'BAD ID!' });
  const check = findCheck(r.checks, 'project-id');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /not a valid GCP project id/);
});

test('project-id: fail "already yours" for an ACTIVE match', async () => {
  const search = mock.fn(async () => ({
    data: { projects: [{ projectId: 'my-taken-id', state: 'ACTIVE' }] },
  }));
  baseMocks({ crm: { projects: { search } } });

  const r = await preflight({ auth: {} as never, projectId: 'my-taken-id' });
  const check = findCheck(r.checks, 'project-id');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /already belongs to you/);
});

test('project-id: warn "soft-deleted" for a DELETE_REQUESTED match, with a counts-until timestamp', async () => {
  const search = mock.fn(async () => ({
    data: {
      projects: [{ projectId: 'ghost-id', state: 'DELETE_REQUESTED', deleteTime: '2026-01-01T00:00:00Z' }],
    },
  }));
  baseMocks({ crm: { projects: { search } } });

  const r = await preflight({ auth: {} as never, projectId: 'ghost-id' });
  const check = findCheck(r.checks, 'project-id');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /soft-deleted/);
  assert.match(check.detail, /counts against quota until 2026-01-31/);
  assert.match(check.detail, /can never be reused/);
});

test('project-id: warn "not among your projects" when search finds nothing', async () => {
  const search = mock.fn(async () => ({ data: { projects: [] } }));
  baseMocks({ crm: { projects: { search } } });

  const r = await preflight({ auth: {} as never, projectId: 'nobodys-id-yet' });
  const check = findCheck(r.checks, 'project-id');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /not among your projects/);
});

test('project-id: skip on a search error (e.g. missing permission)', async () => {
  const search = mock.fn(async () => { throw Object.assign(new Error('permission denied'), { code: 403 }); });
  baseMocks({ crm: { projects: { search } } });

  const r = await preflight({ auth: {} as never, projectId: 'whatever-id' });
  assert.equal(findCheck(r.checks, 'project-id').status, 'skip');
});

test('quota: warn at >=25 ACTIVE+DELETE_REQUESTED projects, pass below the threshold', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ projectId: `p${i}`, state: 'ACTIVE' }));
  baseMocks({ crm: { projects: { search: async () => ({ data: { projects: many } }) } } });

  const warnReport = await preflight({ auth: {} as never });
  assert.equal(findCheck(warnReport.checks, 'quota').status, 'warn');

  mock.restoreAll();
  const few = Array.from({ length: 3 }, (_, i) => ({ projectId: `p${i}`, state: 'ACTIVE' }));
  baseMocks({ crm: { projects: { search: async () => ({ data: { projects: few } }) } } });
  const passReport = await preflight({ auth: {} as never });
  assert.equal(findCheck(passReport.checks, 'quota').status, 'pass');
});

test('quota: DELETE_REQUESTED counts, but other lifecycle states do not', async () => {
  const projects = [
    ...Array.from({ length: 20 }, (_, i) => ({ projectId: `active-${i}`, state: 'ACTIVE' })),
    ...Array.from({ length: 10 }, (_, i) => ({ projectId: `deleted-${i}`, state: 'DELETE_REQUESTED' })),
    { projectId: 'weird', state: 'LIFECYCLE_STATE_UNSPECIFIED' },
  ];
  baseMocks({ crm: { projects: { search: async () => ({ data: { projects } }) } } });

  const r = await preflight({ auth: {} as never });
  assert.match(findCheck(r.checks, 'quota').detail, /^30 project/);
});

test('parent: pass when testIamPermissions echoes the create permission (folder and org)', async () => {
  baseMocks();

  const folderReport = await preflight({ auth: {} as never, parent: 'folders/123' });
  assert.equal(findCheck(folderReport.checks, 'parent').status, 'pass');

  const orgReport = await preflight({ auth: {} as never, parent: 'organizations/456' });
  assert.equal(findCheck(orgReport.checks, 'parent').status, 'pass');
});

test('parent: fail when the permission is missing', async () => {
  baseMocks({
    crm: {
      projects: { search: async () => ({ data: { projects: [] } }) },
      folders: { testIamPermissions: async () => ({ data: { permissions: [] } }) },
      organizations: { testIamPermissions: async () => ({ data: { permissions: [] } }) },
    },
  });

  const r = await preflight({ auth: {} as never, parent: 'folders/123' });
  const check = findCheck(r.checks, 'parent');
  assert.equal(check.status, 'fail');
  assert.ok(check.fix);
});

test('parent: fail fast on a malformed parent, no API call', async () => {
  const testIamPermissions = mock.fn(async () => ({ data: { permissions: [] } }));
  baseMocks({
    crm: {
      projects: { search: async () => ({ data: { projects: [] } }) },
      folders: { testIamPermissions },
      organizations: { testIamPermissions },
    },
  });

  const r = await preflight({ auth: {} as never, parent: 'not-a-real-parent' });
  assert.equal(findCheck(r.checks, 'parent').status, 'fail');
  assert.equal(testIamPermissions.mock.callCount(), 0);
});

test('parent: skip on a permission error', async () => {
  baseMocks({
    crm: {
      projects: { search: async () => ({ data: { projects: [] } }) },
      folders: { testIamPermissions: async () => { throw new Error('403 forbidden'); } },
      organizations: { testIamPermissions: async () => { throw new Error('403 forbidden'); } },
    },
  });

  const r = await preflight({ auth: {} as never, parent: 'folders/123' });
  assert.equal(findCheck(r.checks, 'parent').status, 'skip');
});

test('billing: fail when apis need billing and no account can be resolved', async () => {
  baseMocks(); // cloudbilling defaults to zero accounts

  const r = await preflight({ auth: {} as never, apis: ['aiplatform.googleapis.com'] });
  const check = findCheck(r.checks, 'billing');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /aiplatform\.googleapis\.com/);
});

test('billing: pass when no requested apis need billing, even with no account', async () => {
  baseMocks();

  const r = await preflight({ auth: {} as never, apis: ['gmail.googleapis.com'] });
  assert.equal(findCheck(r.checks, 'billing').status, 'pass');
});

test('billing: fail when the resolved account cannot actually be linked (missing permission)', async () => {
  baseMocks({
    cloudbilling: cloudbillingApi({
      accounts: [{ name: 'billingAccounts/000-AAA', displayName: 'Acme', open: true }],
      testIamPermissions: async () => ({ data: { permissions: [] } }), // missing billing.resourceAssociations.create
    }),
  });

  const r = await preflight({ auth: {} as never, apis: ['run.googleapis.com'] });
  const check = findCheck(r.checks, 'billing');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /billing\.resourceAssociations\.create/);
  assert.match(check.fix ?? '', /roles\/billing\.user/);
});

test('billing: pass when the resolved account can be linked', async () => {
  baseMocks({
    cloudbilling: cloudbillingApi({
      accounts: [{ name: 'billingAccounts/000-AAA', displayName: 'Acme', open: true }],
      testIamPermissions: async () => ({ data: { permissions: ['billing.resourceAssociations.create'] } }),
    }),
  });

  const r = await preflight({ auth: {} as never, apis: ['run.googleapis.com'] });
  assert.equal(findCheck(r.checks, 'billing').status, 'pass');
});

test('billing: skip when the underlying billing API errors', async () => {
  baseMocks({
    cloudbilling: cloudbillingApi({ list: async () => { throw new Error('billing API disabled'); } }),
  });

  const r = await preflight({ auth: {} as never, apis: ['run.googleapis.com'] });
  assert.equal(findCheck(r.checks, 'billing').status, 'skip');
});

test('org-policy: fail with the WIF pointer when key creation is enforced and a key is wanted', async () => {
  baseMocks({ orgpolicy: emptyOrgPolicy(['iam.disableServiceAccountKeyCreation']) });

  const r = await preflight({ auth: {} as never, parent: 'folders/123', wantsServiceAccountKey: true });
  const check = findCheck(r.checks, 'org-policy');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /disableServiceAccountKeyCreation/);
  assert.match(check.fix ?? '', /--wif|workload identity/i);
});

test('org-policy: pass (not fail) when key creation is enforced but no key is wanted', async () => {
  baseMocks({ orgpolicy: emptyOrgPolicy(['iam.disableServiceAccountKeyCreation']) });

  const r = await preflight({ auth: {} as never, parent: 'folders/123', wantsServiceAccountKey: false });
  const check = findCheck(r.checks, 'org-policy');
  assert.notEqual(check.status, 'fail');
});

test('org-policy: warn when restrictServiceUsage has a policy set', async () => {
  const getEffectivePolicy = async ({ name }: { name: string }) => {
    const constraint = name.split('/policies/')[1]!;
    if (constraint === 'gcp.restrictServiceUsage') {
      return { data: { spec: { rules: [{ values: { allowedValues: ['run.googleapis.com'] } }] } } };
    }
    return { data: { spec: { rules: [] } } };
  };
  baseMocks({ orgpolicy: { folders: { policies: { getEffectivePolicy } }, organizations: { policies: { getEffectivePolicy } } } });

  const r = await preflight({ auth: {} as never, parent: 'folders/123', apis: ['run.googleapis.com'] });
  const check = findCheck(r.checks, 'org-policy');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /restrictServiceUsage/);
});

test('org-policy: skip when the parent 403s (no permission to read policy)', async () => {
  const getEffectivePolicy = async () => { throw Object.assign(new Error('caller does not have permission'), { code: 403 }); };
  baseMocks({ orgpolicy: { folders: { policies: { getEffectivePolicy } }, organizations: { policies: { getEffectivePolicy } } } });

  const r = await preflight({ auth: {} as never, parent: 'folders/123' });
  assert.equal(findCheck(r.checks, 'org-policy').status, 'skip');
});

test('org-policy: skip (not evaluated) when no parent is given', async () => {
  baseMocks();

  const r = await preflight({ auth: {} as never });
  assert.equal(findCheck(r.checks, 'org-policy').status, 'skip');
});

test('bootstrap-apis: skip when no quota project is attached', async () => {
  baseMocks();

  const r = await preflight({ auth: {} as never });
  assert.equal(findCheck(r.checks, 'bootstrap-apis').status, 'skip');
});

test("bootstrap-apis: pass/fail based on the quota project's enabled services", async () => {
  baseMocks({ serviceusage: { services: { get: async () => ({ data: { state: 'ENABLED' } }) } } });

  const passReport = await preflight({ auth: { quotaProjectId: 'quota-proj' } as never });
  assert.equal(findCheck(passReport.checks, 'bootstrap-apis').status, 'pass');

  mock.restoreAll();
  baseMocks({ serviceusage: { services: { get: async () => ({ data: { state: 'DISABLED' } }) } } });
  const failReport = await preflight({ auth: { quotaProjectId: 'quota-proj' } as never });
  assert.equal(findCheck(failReport.checks, 'bootstrap-apis').status, 'fail');
});

test('bootstrap-apis: skip on an API error', async () => {
  baseMocks({ serviceusage: { services: { get: async () => { throw new Error('boom'); } } } });

  const r = await preflight({ auth: { quotaProjectId: 'quota-proj' } as never });
  assert.equal(findCheck(r.checks, 'bootstrap-apis').status, 'skip');
});

test('ok is false when any check fails, even if others pass', async () => {
  baseMocks();

  const r = await preflight({ auth: {} as never, projectId: 'not valid!!' });
  assert.equal(r.ok, false);
});
