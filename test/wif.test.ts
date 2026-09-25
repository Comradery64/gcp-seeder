import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import { seedProject } from '../src/seeder.js';
import {
  parseWifTarget,
  githubActionsAuthSnippet,
  gitlabCiAuthSnippet,
  issuerLabel,
  setupWif,
  GITHUB_OIDC_ISSUER,
  GITLAB_OIDC_ISSUER,
} from '../src/wif.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

test('parseWifTarget accepts github:owner/repo and rejects the rest', () => {
  assert.deepEqual(parseWifTarget('github:acme/widgets'), { provider: 'github', repo: 'acme/widgets' });
  assert.deepEqual(parseWifTarget('github:my-org/my.repo_v2'), { provider: 'github', repo: 'my-org/my.repo_v2' });
  assert.throws(() => parseWifTarget('github:no-slash'), /Invalid GitHub repo/);
  assert.throws(() => parseWifTarget('github:acme/'), /Invalid GitHub repo/);
});

test('githubActionsAuthSnippet embeds the provider + SA and requires id-token', () => {
  const snippet = githubActionsAuthSnippet('projects/42/locations/global/x', 'ci@p.iam.gserviceaccount.com');
  assert.match(snippet, /id-token: write/);
  assert.match(snippet, /workload_identity_provider: projects\/42\/locations\/global\/x/);
  assert.match(snippet, /service_account: ci@p\.iam\.gserviceaccount\.com/);
  assert.match(snippet, /google-github-actions\/auth@v2/);
});

/** Shared mocks for CRM + ServiceUsage so seedProject can reach the SA/WIF path. */
function mockCoreApis() {
  const create = mock.fn(async () => ({ data: { name: 'operations/op1' } }));
  const crmGet = mock.fn(async () => ({ data: { done: true, response: { name: 'projects/909090' } } }));
  const batchEnable = mock.fn(async () => ({ data: { name: 'operations/su1' } }));
  const suGet = mock.fn(async () => ({ data: { done: true } }));
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { create }, operations: { get: crmGet } }) as never);
  mock.method(google, 'serviceusage', () => ({ services: { batchEnable }, operations: { get: suGet } }) as never);
  return { batchEnable };
}

/**
 * Advance mocked timers until `promise` settles. seedProject awaits several
 * sleep-gated operation polls (project, APIs, WIF pool, WIF provider); a fixed
 * iteration count is fragile, so we loop until the promise resolves/rejects.
 */
async function drain<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.then(
    (v) => { settled = true; return v; },
    (e) => { settled = true; throw e; },
  );
  tracked.catch(() => {}); // avoid unhandledRejection while we spin
  for (let i = 0; i < 500 && !settled; i++) {
    mock.timers.runAll();
    // Yield a full macrotask (not just a microtask) so the seeder's real fs
    // writes — key file + WIF snippet — can complete between poll iterations.
    await new Promise((r) => setImmediate(r));
  }
  return tracked;
}

test('seed --wif creates a pool + provider locked to the repo and binds the SA', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { batchEnable } = mockCoreApis();

  const saCreate = mock.fn(async () => ({
    data: { name: 'projects/p/serviceAccounts/ci', email: 'ci@p.iam.gserviceaccount.com', uniqueId: '777' },
  }));
  const keyCreate = mock.fn(async () => ({
    data: { privateKeyData: Buffer.from('{"type":"service_account"}').toString('base64') },
  }));
  const poolCreate = mock.fn(async () => ({ data: { name: 'projects/p/locations/global/workloadIdentityPools/gh-pool/operations/1' } }));
  const poolOpGet = mock.fn(async () => ({ data: { done: true } }));
  const providerCreate = mock.fn(async (args: unknown) => {
    return { data: { name: 'projects/p/.../providers/x/operations/2', _args: args } };
  });
  const providerOpGet = mock.fn(async () => ({ data: { done: true } }));
  const getIamPolicy = mock.fn(async () => ({ data: { bindings: [], etag: 'e0' } }));
  const setIamPolicy = mock.fn(async () => ({ data: {} }));

  mock.method(google, 'iam', () => ({
    projects: {
      serviceAccounts: { create: saCreate, keys: { create: keyCreate }, getIamPolicy, setIamPolicy },
      locations: {
        workloadIdentityPools: {
          create: poolCreate,
          operations: { get: poolOpGet },
          providers: { create: providerCreate, operations: { get: providerOpGet } },
        },
      },
    },
  }) as never);

  const outputDir = await mkdtemp(path.join(tmpdir(), 'gcp-seeder-wif-'));
  try {
    const res = await drain(
      seedProject({
        projectId: 'seed-wif-1',
        apis: [],
        credentials: { serviceAccount: true, oauthClient: false },
        wif: { provider: 'github', repo: 'acme/widgets' },
        outputDir,
        auth: {} as never,
        logger: () => {},
      }),
    ) as Awaited<ReturnType<typeof seedProject>>;

    // WIF surfaced on the result, one entry per SA.
    assert.equal(res.wif?.length, 1);
    assert.equal(res.wif?.[0]?.repo, 'acme/widgets');
    assert.equal(res.wif?.[0]?.poolId, 'gh-pool');
    assert.equal(
      res.wif?.[0]?.providerResourceName,
      'projects/909090/locations/global/workloadIdentityPools/gh-pool/providers/gh-acme-widgets',
    );

    // The provider trusts GitHub's issuer and is locked to the exact repo.
    const providerArgs = providerCreate.mock.calls[0]?.arguments[0] as {
      requestBody: { oidc: { issuerUri: string }; attributeCondition: string };
    };
    assert.equal(providerArgs.requestBody.oidc.issuerUri, GITHUB_OIDC_ISSUER);
    assert.equal(providerArgs.requestBody.attributeCondition, "assertion.repository == 'acme/widgets'");

    // The binding grants workloadIdentityUser to the repo's principalSet only.
    const setArgs = setIamPolicy.mock.calls[0]?.arguments[0] as {
      requestBody: { policy: { bindings: Array<{ role: string; members: string[] }> } };
    };
    const binding = setArgs.requestBody.policy.bindings.find((b) => b.role === 'roles/iam.workloadIdentityUser');
    assert.ok(binding, 'expected a workloadIdentityUser binding');
    assert.deepEqual(binding!.members, [
      'principalSet://iam.googleapis.com/projects/909090/locations/global/workloadIdentityPools/gh-pool/attribute.repository/acme/widgets',
    ]);

    // The token-exchange APIs were enabled.
    const enabled = batchEnable.mock.calls.flatMap((c) => (c.arguments[0] as { requestBody: { serviceIds: string[] } }).requestBody.serviceIds);
    assert.ok(enabled.includes('sts.googleapis.com'));
    assert.ok(enabled.includes('iamcredentials.googleapis.com'));

    // The ready-to-paste snippet was written.
    const snippet = await readFile(path.join(outputDir, 'github-actions-auth.yml'), 'utf8');
    assert.match(snippet, /workload_identity_provider: projects\/909090/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('seed --wif reuses an existing pool/provider (409) instead of failing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mockCoreApis();

  const saCreate = mock.fn(async () => ({
    data: { name: 'projects/p/serviceAccounts/ci', email: 'ci@p.iam.gserviceaccount.com', uniqueId: '777' },
  }));
  const keyCreate = mock.fn(async () => ({ data: { privateKeyData: Buffer.from('{}').toString('base64') } }));
  const conflict = async () => {
    throw Object.assign(new Error('Requested entity already exists'), { code: 409 });
  };
  const getIamPolicy = mock.fn(async () => ({ data: { bindings: [], etag: 'e0' } }));
  const setIamPolicy = mock.fn(async () => ({ data: {} }));

  mock.method(google, 'iam', () => ({
    projects: {
      serviceAccounts: { create: saCreate, keys: { create: keyCreate }, getIamPolicy, setIamPolicy },
      locations: {
        workloadIdentityPools: {
          create: mock.fn(conflict),
          get: mock.fn(async () => ({ data: { state: 'ACTIVE' } })),
          operations: { get: mock.fn(async () => ({ data: { done: true } })) },
          providers: {
            create: mock.fn(conflict),
            get: mock.fn(async () => ({ data: { state: 'ACTIVE' } })),
            operations: { get: mock.fn(async () => ({ data: { done: true } })) },
          },
        },
      },
    },
  }) as never);

  const res = await drain(
    seedProject({
      projectId: 'seed-wif-2',
      apis: [],
      credentials: { serviceAccount: true, oauthClient: false },
      wif: { provider: 'github', repo: 'acme/widgets' },
      outputDir: '/tmp/should-not-matter',
      auth: {} as never,
      logger: () => {},
    }),
  ) as Awaited<ReturnType<typeof seedProject>>;

  // Reused resources → still bound, still surfaced.
  assert.equal(res.wif?.length, 1);
  assert.equal(setIamPolicy.mock.callCount(), 1);
});

test('seed --wif retries pool creation while iam.googleapis.com is still propagating', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mockCoreApis();

  const saCreate = mock.fn(async () => ({
    data: { name: 'projects/p/serviceAccounts/ci', email: 'ci@p.iam.gserviceaccount.com', uniqueId: '777' },
  }));
  const keyCreate = mock.fn(async () => ({ data: { privateKeyData: Buffer.from('{}').toString('base64') } }));

  // The IAM WIF API often 403s for ~30-90s right after serviceusage.enable
  // reports it enabled. First pool-create attempt fails with that exact shape;
  // the second succeeds — the seeder must retry, not abort.
  let poolAttempts = 0;
  const poolCreate = mock.fn(async () => {
    poolAttempts += 1;
    if (poolAttempts === 1) {
      throw Object.assign(
        new Error("Permission 'iam.workloadIdentityPools.create' denied on resource (or it may not exist)."),
        { code: 403 },
      );
    }
    return { data: { name: 'op/pool' } };
  });
  const getIamPolicy = mock.fn(async () => ({ data: { bindings: [], etag: 'e0' } }));
  const setIamPolicy = mock.fn(async () => ({ data: {} }));

  mock.method(google, 'iam', () => ({
    projects: {
      serviceAccounts: { create: saCreate, keys: { create: keyCreate }, getIamPolicy, setIamPolicy },
      locations: {
        workloadIdentityPools: {
          create: poolCreate,
          operations: { get: mock.fn(async () => ({ data: { done: true } })) },
          providers: {
            create: mock.fn(async () => ({ data: { name: 'op/prov' } })),
            operations: { get: mock.fn(async () => ({ data: { done: true } })) },
          },
        },
      },
    },
  }) as never);

  const res = await drain(
    seedProject({
      projectId: 'seed-wif-4',
      apis: [],
      credentials: { serviceAccount: true, oauthClient: false },
      wif: { provider: 'github', repo: 'acme/widgets' },
      outputDir: '/tmp/should-not-matter',
      auth: {} as never,
      logger: () => {},
    }),
  );

  assert.equal(poolAttempts, 2, 'pool creation was retried after the propagation 403');
  assert.equal(res.wif?.length, 1);
  assert.equal(setIamPolicy.mock.callCount(), 1);
});

test('seed --wif warns instead of throwing when the SA binding fails (no half-provisioned project)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mockCoreApis();

  const saCreate = mock.fn(async () => ({
    data: { name: 'projects/p/serviceAccounts/ci', email: 'ci@p.iam.gserviceaccount.com', uniqueId: '777' },
  }));
  const keyCreate = mock.fn(async () => ({ data: { privateKeyData: Buffer.from('{}').toString('base64') } }));
  // Pool + provider create fine, but the caller lacks setIamPolicy on the SA
  // (a persistent 403, not the propagation shape) — must warn, not abort.
  const denied = async () => {
    throw Object.assign(new Error("Permission 'iam.serviceAccounts.setIamPolicy' was denied."), { code: 403 });
  };

  mock.method(google, 'iam', () => ({
    projects: {
      serviceAccounts: { create: saCreate, keys: { create: keyCreate }, getIamPolicy: mock.fn(denied), setIamPolicy: mock.fn(async () => ({ data: {} })) },
      locations: {
        workloadIdentityPools: {
          create: mock.fn(async () => ({ data: { name: 'op/pool' } })),
          operations: { get: mock.fn(async () => ({ data: { done: true } })) },
          providers: {
            create: mock.fn(async () => ({ data: { name: 'op/prov' } })),
            operations: { get: mock.fn(async () => ({ data: { done: true } })) },
          },
        },
      },
    },
  }) as never);

  const res = await drain(
    seedProject({
      projectId: 'seed-wif-5',
      apis: [],
      credentials: { serviceAccount: true, oauthClient: false },
      wif: { provider: 'github', repo: 'acme/widgets' },
      outputDir: '/tmp/should-not-matter',
      auth: {} as never,
      logger: () => {},
    }),
  ); // must NOT throw

  // The project + SA survive; WIF is not surfaced; an actionable warning explains how to finish.
  assert.equal(res.projectId, 'seed-wif-5');
  assert.equal(res.serviceAccounts?.length, 1);
  assert.equal(res.wif, undefined);
  assert.ok(res.warnings.some((w) => /Workload Identity Federation .* did not fully complete/.test(w)), 'expected a WIF warning');
  assert.ok(res.warnings.some((w) => /idempotent/.test(w)), 'warning should mention re-running is idempotent');
});

test('seed --wif without any service account fails before creating anything', async () => {
  await assert.rejects(
    seedProject({
      projectId: 'seed-wif-3',
      apis: [],
      credentials: { serviceAccount: false, oauthClient: false },
      wif: { provider: 'github', repo: 'acme/widgets' },
      auth: {} as never,
      logger: () => {},
    }),
    /wif requires at least one service account/,
  );
});

// ---- J: GitLab provider + undelete handling --------------------------------

test('parseWifTarget accepts gitlab:group/project incl. nested groups and rejects bad paths', () => {
  assert.deepEqual(parseWifTarget('gitlab:acme/widgets'), { provider: 'gitlab', repo: 'acme/widgets' });
  assert.deepEqual(parseWifTarget('gitlab:acme/platform/infra.tools'), {
    provider: 'gitlab',
    repo: 'acme/platform/infra.tools',
  });
  assert.deepEqual(parseWifTarget('gitlab:_grp/my_proj-2'), { provider: 'gitlab', repo: '_grp/my_proj-2' });
  for (const bad of [
    'gitlab:solo',
    'gitlab:acme/',
    'gitlab:/widgets',
    'gitlab:acme//widgets',
    'gitlab:acme/widgets.git',
    'gitlab:acme/-bad',
    'gitlab:acme/bad.',
    "gitlab:acme/w' || true || '",
    'gitlab:acme/wid gets',
  ]) {
    assert.throws(() => parseWifTarget(bad), /Invalid GitLab project/, bad);
  }
  assert.throws(() => parseWifTarget('bitbucket:acme/widgets'), /Unsupported --wif provider/);
});

test('issuerLabel classifies issuer URIs', () => {
  assert.equal(issuerLabel(GITHUB_OIDC_ISSUER), 'github');
  assert.equal(issuerLabel('https://gitlab.com'), 'gitlab');
  assert.equal(issuerLabel('https://gitlab.com/'), 'gitlab');
  assert.equal(issuerLabel('https://gitlab.example.com'), 'other');
  assert.equal(issuerLabel('https://accounts.google.com'), 'other');
  assert.equal(issuerLabel(undefined), 'unknown');
  assert.equal(issuerLabel(''), 'unknown');
});

interface IamMockOpts {
  poolCreate?: () => Promise<unknown>;
  providerCreate?: () => Promise<unknown>;
  poolState?: string;
  providerState?: string;
}

function mockIam(o: IamMockOpts = {}) {
  const done = () => mock.fn(async () => ({ data: { done: true } }));
  const m = {
    poolCreate: mock.fn(o.poolCreate ?? (async () => ({ data: { name: 'op/pool' } }))),
    poolGet: mock.fn(async () => ({ data: { state: o.poolState ?? 'ACTIVE' } })),
    poolUndelete: mock.fn(async () => ({ data: { name: 'op/pool-undelete' } })),
    poolOpGet: done(),
    providerCreate: mock.fn(o.providerCreate ?? (async () => ({ data: { name: 'op/prov' } }))),
    providerGet: mock.fn(async () => ({ data: { state: o.providerState ?? 'ACTIVE' } })),
    providerUndelete: mock.fn(async () => ({ data: { name: 'op/prov-undelete' } })),
    providerOpGet: done(),
    getIamPolicy: mock.fn(async () => ({ data: { bindings: [], etag: 'e0' } })),
    setIamPolicy: mock.fn(async (_req: unknown) => ({ data: {} })),
  };
  mock.method(google, 'iam', () => ({
    projects: {
      serviceAccounts: { getIamPolicy: m.getIamPolicy, setIamPolicy: m.setIamPolicy },
      locations: {
        workloadIdentityPools: {
          create: m.poolCreate,
          get: m.poolGet,
          undelete: m.poolUndelete,
          operations: { get: m.poolOpGet },
          providers: {
            create: m.providerCreate,
            get: m.providerGet,
            undelete: m.providerUndelete,
            operations: { get: m.providerOpGet },
          },
        },
      },
    },
  }) as never);
  return m;
}

const conflict = async () => {
  throw Object.assign(new Error('Requested entity already exists'), { code: 409 });
};

function boundMembers(m: ReturnType<typeof mockIam>): string[] {
  const req = m.setIamPolicy.mock.calls[0].arguments[0] as {
    requestBody: { policy: { bindings: { role: string; members: string[] }[] } };
  };
  return req.requestBody.policy.bindings.find((b) => b.role === 'roles/iam.workloadIdentityUser')!.members;
}

const SA = 'ci@p.iam.gserviceaccount.com';

test('setupWif(gitlab) locks the provider to exactly one project and writes the gitlab-ci snippet', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const m = mockIam();
  const outputDir = await mkdtemp(path.join(tmpdir(), 'wif-gl-'));
  try {
    const res = await drain(
      setupWif(
        {} as never,
        {
          projectId: 'p',
          projectNumber: '123456',
          serviceAccountEmail: SA,
          target: { provider: 'gitlab', repo: 'acme/platform/widgets' },
          outputDir,
        },
        () => {},
      ),
    );

    const poolReq = m.poolCreate.mock.calls[0].arguments[0] as { workloadIdentityPoolId: string };
    assert.equal(poolReq.workloadIdentityPoolId, 'gl-pool');

    const provReq = m.providerCreate.mock.calls[0].arguments[0] as {
      parent: string;
      workloadIdentityPoolProviderId: string;
      requestBody: { oidc: { issuerUri: string }; attributeMapping: Record<string, string>; attributeCondition: string };
    };
    assert.equal(provReq.parent, 'projects/p/locations/global/workloadIdentityPools/gl-pool');
    assert.equal(provReq.workloadIdentityPoolProviderId, 'gl-acme-platform-widgets');
    assert.equal(provReq.requestBody.oidc.issuerUri, 'https://gitlab.com');
    assert.equal(provReq.requestBody.oidc.issuerUri, GITLAB_OIDC_ISSUER);
    assert.deepEqual(provReq.requestBody.attributeMapping, {
      'google.subject': 'assertion.sub',
      'attribute.project_path': 'assertion.project_path',
    });
    assert.equal(provReq.requestBody.attributeCondition, "assertion.project_path == 'acme/platform/widgets'");

    assert.deepEqual(boundMembers(m), [
      'principalSet://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/gl-pool/attribute.project_path/acme/platform/widgets',
    ]);

    const providerResource =
      'projects/123456/locations/global/workloadIdentityPools/gl-pool/providers/gl-acme-platform-widgets';
    assert.equal(res.providerResourceName, providerResource);
    assert.equal(res.repo, 'acme/platform/widgets');
    assert.equal(res.workflowSnippetFile, path.join(outputDir, 'gitlab-ci-auth.yml'));
    const snippet = await readFile(res.workflowSnippetFile!, 'utf8');
    assert.equal(snippet, gitlabCiAuthSnippet(providerResource, SA));
    assert.match(snippet, /id_tokens:\n {4}GITLAB_OIDC_TOKEN:\n {6}aud: https:\/\/iam\.googleapis\.com\/projects\/123456\/locations\/global\/workloadIdentityPools\/gl-pool\/providers\/gl-acme-platform-widgets\n/);
    assert.ok(snippet.includes(`gcloud iam workload-identity-pools create-cred-config ${providerResource}`));
    assert.ok(snippet.includes(`--service-account=${SA}`));
    assert.match(snippet, /--credential-source-file=\S+/);
    assert.match(snippet, /--output-file=\S+/);
    assert.match(snippet, /gcloud auth login --cred-file=\S+/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('setupWif(github) keeps its exact repo condition and principal (regression)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const m = mockIam();
  const res = await drain(
    setupWif(
      {} as never,
      { projectId: 'p', projectNumber: '42', serviceAccountEmail: SA, target: { provider: 'github', repo: 'acme/widgets' } },
      () => {},
    ),
  );
  const poolReq = m.poolCreate.mock.calls[0].arguments[0] as { workloadIdentityPoolId: string };
  assert.equal(poolReq.workloadIdentityPoolId, 'gh-pool');
  const provReq = m.providerCreate.mock.calls[0].arguments[0] as {
    workloadIdentityPoolProviderId: string;
    requestBody: { oidc: { issuerUri: string }; attributeCondition: string };
  };
  assert.equal(provReq.workloadIdentityPoolProviderId, 'gh-acme-widgets');
  assert.equal(provReq.requestBody.oidc.issuerUri, GITHUB_OIDC_ISSUER);
  assert.equal(provReq.requestBody.attributeCondition, "assertion.repository == 'acme/widgets'");
  assert.deepEqual(boundMembers(m), [
    'principalSet://iam.googleapis.com/projects/42/locations/global/workloadIdentityPools/gh-pool/attribute.repository/acme/widgets',
  ]);
  assert.equal(res.workflowSnippetFile, undefined);
});

test('setupWif undeletes a soft-deleted pool and provider after a 409, then continues', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const m = mockIam({ poolCreate: conflict, providerCreate: conflict, poolState: 'DELETED', providerState: 'DELETED' });
  const logs: string[] = [];
  const res = await drain(
    setupWif(
      {} as never,
      { projectId: 'p', projectNumber: '42', serviceAccountEmail: SA, target: { provider: 'gitlab', repo: 'acme/widgets' } },
      (msg) => logs.push(msg),
    ),
  );
  assert.equal(m.poolGet.mock.callCount(), 1);
  assert.deepEqual(m.poolGet.mock.calls[0].arguments[0], { name: 'projects/p/locations/global/workloadIdentityPools/gl-pool' });
  assert.equal(m.poolUndelete.mock.callCount(), 1);
  assert.equal(
    (m.poolUndelete.mock.calls[0].arguments[0] as { name: string }).name,
    'projects/p/locations/global/workloadIdentityPools/gl-pool',
  );
  assert.ok(m.poolOpGet.mock.calls.some((c) => (c.arguments[0] as { name: string }).name === 'op/pool-undelete'));
  assert.equal(m.providerUndelete.mock.callCount(), 1);
  assert.equal(
    (m.providerUndelete.mock.calls[0].arguments[0] as { name: string }).name,
    'projects/p/locations/global/workloadIdentityPools/gl-pool/providers/gl-acme-widgets',
  );
  assert.ok(m.providerOpGet.mock.calls.some((c) => (c.arguments[0] as { name: string }).name === 'op/prov-undelete'));
  assert.ok(logs.some((l) => /pool "gl-pool" is soft-deleted/.test(l)));
  assert.ok(logs.some((l) => /provider "gl-acme-widgets" undeleted/.test(l)));
  assert.equal(m.setIamPolicy.mock.callCount(), 1, 'continued on to the binding');
  assert.equal(res.poolId, 'gl-pool');
});

test('setupWif reuses an ACTIVE pool/provider after a 409 without undeleting', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const m = mockIam({ poolCreate: conflict, providerCreate: conflict });
  await drain(
    setupWif(
      {} as never,
      { projectId: 'p', projectNumber: '42', serviceAccountEmail: SA, target: { provider: 'github', repo: 'acme/widgets' } },
      () => {},
    ),
  );
  assert.equal(m.poolGet.mock.callCount(), 1);
  assert.equal(m.providerGet.mock.callCount(), 1);
  assert.equal(m.poolUndelete.mock.callCount(), 0);
  assert.equal(m.providerUndelete.mock.callCount(), 0);
  assert.equal(m.setIamPolicy.mock.callCount(), 1);
});
