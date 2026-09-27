import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import type { WifPoolInfo, WifResult, WifTarget } from './types.js';

/** GitHub's OIDC token issuer — the trust anchor for GitHub Actions federation. */
export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * APIs that must be enabled for token exchange to actually work at runtime.
 * `iam.googleapis.com` hosts the pool/provider resources (already bootstrapped);
 * `sts.googleapis.com` performs the OIDC→Google token exchange; and
 * `iamcredentials.googleapis.com` backs the service-account impersonation
 * `google-github-actions/auth` uses to mint the final access token.
 */
export const WIF_APIS = ['sts.googleapis.com', 'iamcredentials.googleapis.com'];

/** The IAM role that lets a federated principal impersonate the service account. */
const WORKLOAD_IDENTITY_USER = 'roles/iam.workloadIdentityUser';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GitLab.com's OIDC token issuer — the trust anchor for GitLab CI federation. */
export const GITLAB_OIDC_ISSUER = 'https://gitlab.com';

/** One GitLab namespace/project path segment (letters, digits, `_`, `-`, `.`). */
const GITLAB_SEGMENT = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;

/**
 * Parse a `--wif` target: `github:owner/repo` or `gitlab:group/project`
 * (nested groups allowed: `gitlab:group/sub/project`). The value is validated
 * against the provider's naming rules so a typo fails here rather than
 * producing a pool that trusts nothing (or, worse, the wrong repo). The strict
 * charsets also keep quotes out of the CEL attribute condition.
 */
export function parseWifTarget(spec: string): WifTarget {
  const [scheme, ...rest] = spec.split(':');
  const value = rest.join(':').trim();
  if (scheme === 'github') {
    // GitHub owner and repo charsets; keeps us from minting a pool for garbage.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error(
        `Invalid GitHub repo "${value}" in --wif. Expected the form "github:owner/repo".`,
      );
    }
    return { provider: 'github', repo: value };
  }
  if (scheme === 'gitlab') {
    const segments = value.split('/');
    if (
      segments.length < 2 ||
      !segments.every((seg) => GITLAB_SEGMENT.test(seg) && !seg.endsWith('.git') && !seg.includes('..'))
    ) {
      throw new Error(
        `Invalid GitLab project "${value}" in --wif. Expected the form "gitlab:group/project" ` +
          '(nested groups allowed: "gitlab:group/sub/project").',
      );
    }
    return { provider: 'gitlab', repo: value };
  }
  throw new Error(
    `Unsupported --wif provider "${scheme}". Supported: "github:owner/repo", "gitlab:group/project".`,
  );
}

/**
 * Classify an OIDC provider's issuer URI — used by `audit` to label pools.
 * `undefined`/empty means the provider isn't OIDC (or the field was missing).
 */
export function issuerLabel(issuerUri?: string): 'github' | 'gitlab' | 'other' | 'unknown' {
  if (!issuerUri) return 'unknown';
  const norm = issuerUri.trim().replace(/\/+$/, '');
  if (norm === GITHUB_OIDC_ISSUER) return 'github';
  if (norm === GITLAB_OIDC_ISSUER) return 'gitlab';
  return 'other';
}

/**
 * Turn free-form text into a valid pool/provider id: 4-32 chars,
 * `[a-z0-9-]`, must start with a letter, must not end with a hyphen, and must
 * not start with the reserved `gcp-` prefix. We always prefix `gh-`/`gl-` so both the
 * "starts with a letter" and "not gcp-" rules hold regardless of input.
 */
function toResourceId(base: string, prefix = 'gh'): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${prefix}-${slug}`.slice(0, 32).replace(/-+$/g, '');
}

/**
 * The `principalSet://` member for a GitHub repo. Scoping the binding to
 * `attribute.repository/<owner>/<repo>` is what makes this safe: only OIDC
 * tokens whose `repository` claim matches can impersonate the SA. This MUST use
 * the numeric project number — the id form is not accepted by IAM here.
 */
function repoPrincipalSet(projectNumber: string, poolId: string, repo: string): string {
  return (
    `principalSet://iam.googleapis.com/projects/${projectNumber}` +
    `/locations/global/workloadIdentityPools/${poolId}/attribute.repository/${repo}`
  );
}

/**
 * The `principalSet://` member for a GitLab project, scoped to
 * `attribute.project_path/<group/project>` — same safety argument as above.
 */
function gitlabPrincipalSet(projectNumber: string, poolId: string, projectPath: string): string {
  return (
    `principalSet://iam.googleapis.com/projects/${projectNumber}` +
    `/locations/global/workloadIdentityPools/${poolId}/attribute.project_path/${projectPath}`
  );
}

/** The `workload_identity_provider` value for `google-github-actions/auth`. */
function providerResourceName(projectNumber: string, poolId: string, providerId: string): string {
  return (
    `projects/${projectNumber}/locations/global/workloadIdentityPools/` +
    `${poolId}/providers/${providerId}`
  );
}

/** Poll an IAM long-running operation until it reports done. */
async function waitForIamOperation(
  getOp: () => Promise<{ done?: boolean | null; error?: unknown; name?: string | null }>,
  log: (m: string) => void,
  { timeoutMs = 120_000, intervalMs = 3_000 } = {},
): Promise<void> {
  const start = Date.now();
  await sleep(intervalMs);
  for (;;) {
    const op = await getOp();
    if (op.done) {
      if (op.error) throw new Error(`Operation failed: ${JSON.stringify(op.error)}`);
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for the Workload Identity operation to complete.');
    }
    log('  …still working');
    await sleep(intervalMs);
  }
}

/** True when a create call failed because the resource already exists (409). */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 409 || /already exists/i.test(msg);
}

/**
 * True when a call was denied because `iam.googleapis.com`'s workload-identity
 * sub-resources haven't finished propagating yet. Observed in practice: right
 * after `serviceusage.enable` reports the API enabled, pool/provider creation
 * can still 403 with this exact message for ~30-90s. Distinct from a real
 * permissions problem, which persists across retries.
 */
function isApiNotYetPropagated(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 403 && /denied on resource|or it may not exist/i.test(msg);
}

/** Retry an IAM call while the just-enabled API is still propagating. */
async function withPropagationRetry<T>(
  fn: () => Promise<T>,
  log: (m: string) => void,
  { attempts = 10, intervalMs = 8_000 } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isApiNotYetPropagated(err) || attempt >= attempts) throw err;
      log('  iam.googleapis.com still propagating — retrying…');
      await sleep(intervalMs);
    }
  }
}

export interface SetupWifOptions {
  projectId: string;
  /** Numeric project number — required for the principalSet + snippet resource names. */
  projectNumber: string;
  /** SA to bind for impersonation, e.g. "ci@proj.iam.gserviceaccount.com". */
  serviceAccountEmail: string;
  /** Pool id override. Defaults to "gh-pool" (GitHub) / "gl-pool" (GitLab). */
  poolId?: string;
  /** Provider id override. Defaults to one derived from the repo / project path. */
  providerId?: string;
  /** If set, the ready-to-paste CI snippet is written here. */
  outputDir?: string;
}

export interface SetupGithubWifOptions extends SetupWifOptions {
  /** "owner/repo" whose OIDC tokens may impersonate the SA. */
  repo: string;
}

/** Per-provider trust configuration. The attribute condition is the security boundary. */
interface ProviderProfile {
  defaultPoolId: string;
  idPrefix: string;
  poolDisplayName: string;
  issuerUri: string;
  attributeMapping: Record<string, string>;
  attributeCondition: string;
  member: (projectNumber: string, poolId: string) => string;
  snippetFile: string;
  snippet: (providerResource: string, saEmail: string) => string;
  snippetLabel: string;
}

function providerProfile(target: WifTarget): ProviderProfile {
  const repo = target.repo;
  if (target.provider === 'gitlab') {
    return {
      defaultPoolId: 'gl-pool',
      idPrefix: 'gl',
      poolDisplayName: 'GitLab CI',
      issuerUri: GITLAB_OIDC_ISSUER,
      attributeMapping: {
        'google.subject': 'assertion.sub',
        'attribute.project_path': 'assertion.project_path',
      },
      attributeCondition: `assertion.project_path == '${repo}'`,
      member: (num, pool) => gitlabPrincipalSet(num, pool, repo),
      snippetFile: 'gitlab-ci-auth.yml',
      snippet: gitlabCiAuthSnippet,
      snippetLabel: 'GitLab CI',
    };
  }
  return {
    defaultPoolId: 'gh-pool',
    idPrefix: 'gh',
    poolDisplayName: 'GitHub Actions',
    issuerUri: GITHUB_OIDC_ISSUER,
    attributeMapping: {
      'google.subject': 'assertion.sub',
      'attribute.repository': 'assertion.repository',
      'attribute.repository_owner': 'assertion.repository_owner',
    },
    attributeCondition: `assertion.repository == '${repo}'`,
    member: (num, pool) => repoPrincipalSet(num, pool, repo),
    snippetFile: 'github-actions-auth.yml',
    snippet: githubActionsAuthSnippet,
    snippetLabel: 'GitHub Actions',
  };
}

type IamOp = { done?: boolean | null; error?: unknown; name?: string | null };

/**
 * After a create 409s, check whether the existing resource is soft-deleted
 * (deleted pool/provider ids linger for ~30 days and cannot be re-created).
 * If so, undelete it and wait for the LRO; otherwise it's live and reused.
 */
async function reuseOrUndelete(
  kind: 'pool' | 'provider',
  id: string,
  get: () => Promise<{ data: { state?: string | null } }>,
  undelete: () => Promise<{ data: IamOp }>,
  getOp: (name: string) => Promise<{ data: IamOp }>,
  log: (m: string) => void,
): Promise<void> {
  const { data } = await get();
  if (data.state === 'DELETED') {
    log(`  ${kind} "${id}" is soft-deleted (30-day recovery window) — undeleting it`);
    const op = await undelete();
    await waitForIamOperation(async () => (await getOp(op.data.name!)).data, log);
    log(`  ✓ ${kind} "${id}" undeleted`);
    return;
  }
  log(`  ${kind} "${id}" already exists — reusing it`);
}

/**
 * Set up keyless CI auth (GitHub Actions or GitLab CI) for a service account:
 *   1. create a workload identity pool,
 *   2. create an OIDC provider trusting the CI issuer, locked to exactly one
 *      repo / project via an attribute condition,
 *   3. grant that repo's federated principal `roles/iam.workloadIdentityUser`
 *      on the SA,
 *   4. return (and optionally write) a ready-to-paste CI snippet.
 *
 * Idempotent: an existing pool/provider (409) is reused; a soft-deleted one is
 * undeleted first.
 */
export async function setupWif(
  auth: AuthClient,
  opts: SetupWifOptions & { target: WifTarget },
  log: (m: string) => void,
): Promise<WifResult> {
  const iam = google.iam({ version: 'v1', auth: auth as never });
  const pools = iam.projects.locations.workloadIdentityPools;
  const { projectId, projectNumber, serviceAccountEmail, target } = opts;
  const repo = target.repo;
  const profile = providerProfile(target);
  const poolId = opts.poolId ?? profile.defaultPoolId;
  const providerId = opts.providerId ?? toResourceId(repo, profile.idPrefix);
  const locationParent = `projects/${projectId}/locations/global`;
  const poolName = `${locationParent}/workloadIdentityPools/${poolId}`;
  const providerName = `${poolName}/providers/${providerId}`;

  // 1. Workload identity pool.
  log(`Creating workload identity pool "${poolId}"…`);
  try {
    const op = await withPropagationRetry(
      () =>
        pools.create({
          parent: locationParent,
          workloadIdentityPoolId: poolId,
          requestBody: {
            displayName: profile.poolDisplayName,
            description: 'Keyless CI auth created by gcp-seeder',
          },
        }),
      log,
    );
    await waitForIamOperation(async () => (await pools.operations.get({ name: op.data.name! })).data, log);
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await reuseOrUndelete(
      'pool',
      poolId,
      () => pools.get({ name: poolName }),
      () => pools.undelete({ name: poolName, requestBody: {} }),
      (name) => pools.operations.get({ name }),
      log,
    );
  }

  // 2. OIDC provider, locked to the target repo/project via an attribute
  //    condition. Without it the shared issuer would let ANY repo/project mint
  //    a token this pool trusts — the condition is the security boundary.
  log(`Creating OIDC provider "${providerId}" for ${repo}…`);
  try {
    const op = await withPropagationRetry(
      () =>
        pools.providers.create({
          parent: poolName,
          workloadIdentityPoolProviderId: providerId,
          requestBody: {
            displayName: repo.slice(0, 32),
            oidc: { issuerUri: profile.issuerUri },
            attributeMapping: profile.attributeMapping,
            attributeCondition: profile.attributeCondition,
          },
        }),
      log,
    );
    await waitForIamOperation(
      async () => (await pools.providers.operations.get({ name: op.data.name! })).data,
      log,
    );
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await reuseOrUndelete(
      'provider',
      providerId,
      () => pools.providers.get({ name: providerName }),
      () => pools.providers.undelete({ name: providerName, requestBody: {} }),
      (name) => pools.providers.operations.get({ name }),
      log,
    );
  }

  // 3. Bind the federated principal to the SA (read-modify-write policy).
  //    A just-created SA can 403 here for the same propagation reason pools do,
  //    so retry the whole read-modify-write under the same backoff.
  const saResource = `projects/${projectId}/serviceAccounts/${serviceAccountEmail}`;
  const member = profile.member(projectNumber, poolId);
  log(`Granting ${WORKLOAD_IDENTITY_USER} to ${repo} on ${serviceAccountEmail}…`);
  await withPropagationRetry(async () => {
    const { data: policy } = await iam.projects.serviceAccounts.getIamPolicy({ resource: saResource });
    const bindings = policy.bindings ?? [];
    let binding = bindings.find((b) => b.role === WORKLOAD_IDENTITY_USER);
    if (!binding) {
      binding = { role: WORKLOAD_IDENTITY_USER, members: [] };
      bindings.push(binding);
    }
    if (!binding.members?.includes(member)) {
      binding.members = [...(binding.members ?? []), member];
    }
    await iam.projects.serviceAccounts.setIamPolicy({
      resource: saResource,
      requestBody: { policy: { ...policy, bindings } },
    });
  }, log);
  log('✓ Workload identity binding applied');

  const providerResource = providerResourceName(projectNumber, poolId, providerId);
  const result: WifResult = {
    poolId,
    providerId,
    providerResourceName: providerResource,
    serviceAccountEmail,
    repo,
  };

  // 4. Ready-to-paste CI snippet.
  if (opts.outputDir) {
    const file = path.join(opts.outputDir, profile.snippetFile);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, profile.snippet(providerResource, serviceAccountEmail), 'utf8');
    result.workflowSnippetFile = file;
    log(`✓ ${profile.snippetLabel} auth snippet written to ${file}`);
  }

  return result;
}

/** GitHub-only entry point kept for existing callers; delegates to {@link setupWif}. */
export async function setupGithubWif(
  auth: AuthClient,
  opts: SetupGithubWifOptions,
  log: (m: string) => void,
): Promise<WifResult> {
  const { repo, ...rest } = opts;
  return setupWif(auth, { ...rest, target: { provider: 'github', repo } }, log);
}

/**
 * List every workload identity pool (and its OIDC providers) in a project.
 * Read-only — used by `audit`. Deleted pools are not returned (the API hides
 * them unless showDeleted is set, which we don't).
 */
export async function listWifPools(auth: AuthClient, projectId: string): Promise<WifPoolInfo[]> {
  const iam = google.iam({ version: 'v1', auth: auth as never });
  const parent = `projects/${projectId}/locations/global`;
  const { data } = await iam.projects.locations.workloadIdentityPools.list({ parent });
  const pools = data.workloadIdentityPools ?? [];
  const out: WifPoolInfo[] = [];
  for (const pool of pools) {
    const poolName = pool.name ?? '';
    const { data: provData } = await iam.projects.locations.workloadIdentityPools.providers.list({
      parent: poolName,
    });
    const providers = (provData.workloadIdentityPoolProviders ?? []).map((p) => ({
      providerId: (p.name ?? '').split('/').pop() ?? '',
      displayName: p.displayName ?? undefined,
      issuerUri: p.oidc?.issuerUri ?? undefined,
      attributeCondition: p.attributeCondition ?? undefined,
      disabled: p.disabled ?? undefined,
    }));
    out.push({
      poolId: poolName.split('/').pop() ?? '',
      displayName: pool.displayName ?? undefined,
      disabled: pool.disabled ?? undefined,
      providers,
    });
  }
  return out;
}

/**
 * Soft-delete a workload identity pool. Deleting the pool cascades to its
 * providers and enters GCP's ~30-day recovery window (like project deletion),
 * so it's reversible within that window. Used by `destroy`.
 */
export async function deleteWifPool(auth: AuthClient, projectId: string, poolId: string): Promise<void> {
  const iam = google.iam({ version: 'v1', auth: auth as never });
  const name = `projects/${projectId}/locations/global/workloadIdentityPools/${poolId}`;
  await iam.projects.locations.workloadIdentityPools.delete({ name });
}

/**
 * A ready-to-paste `google-github-actions/auth` step. This is public,
 * non-secret configuration (no key material) — the whole point of WIF.
 */
export function githubActionsAuthSnippet(providerResource: string, serviceAccountEmail: string): string {
  return [
    '# Keyless auth via Workload Identity Federation — no service-account key needed.',
    '# Requires: permissions: { id-token: write } on the job.',
    'permissions:',
    '  contents: read',
    '  id-token: write',
    '',
    'steps:',
    '  - uses: google-github-actions/auth@v2',
    '    with:',
    `      workload_identity_provider: ${providerResource}`,
    `      service_account: ${serviceAccountEmail}`,
    '',
  ].join('\n');
}

/**
 * A ready-to-paste GitLab CI job fragment. GitLab mints the OIDC token via
 * `id_tokens`; gcloud exchanges it through the provider and impersonates the
 * SA. Public, non-secret configuration — no key material.
 */
export function gitlabCiAuthSnippet(providerResource: string, serviceAccountEmail: string): string {
  return [
    '# Keyless auth via Workload Identity Federation — no service-account key needed.',
    '# Merge into a job that has the gcloud CLI available.',
    'gcp-auth:',
    '  id_tokens:',
    '    GITLAB_OIDC_TOKEN:',
    `      aud: https://iam.googleapis.com/${providerResource}`,
    '  script:',
    '    - echo "$GITLAB_OIDC_TOKEN" > .ci_job_jwt_file',
    `    - gcloud iam workload-identity-pools create-cred-config ${providerResource}`,
    `      --service-account=${serviceAccountEmail}`,
    '      --credential-source-file=.ci_job_jwt_file',
    '      --output-file=.gcp_temp_cred.json',
    '    - gcloud auth login --cred-file=.gcp_temp_cred.json',
    '',
  ].join('\n');
}
