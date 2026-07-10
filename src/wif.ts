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

/**
 * Parse a `--wif` target of the form `github:owner/repo`. Only GitHub OIDC is
 * supported today; the `provider:` prefix is required so other providers can be
 * added later without ambiguity. `owner/repo` is validated against GitHub's
 * naming rules so a typo fails here rather than producing a pool that trusts
 * nothing (or, worse, the wrong repo).
 */
export function parseWifTarget(spec: string): WifTarget {
  const [scheme, ...rest] = spec.split(':');
  const value = rest.join(':');
  if (scheme !== 'github') {
    throw new Error(
      `Unsupported --wif provider "${scheme}". Only "github:owner/repo" is supported today.`,
    );
  }
  const repo = value.trim();
  // GitHub owner and repo charsets; keeps us from minting a pool for garbage.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(
      `Invalid GitHub repo "${repo}" in --wif. Expected the form "github:owner/repo".`,
    );
  }
  return { provider: 'github', repo };
}

/**
 * Turn free-form text into a valid pool/provider id: 4-32 chars,
 * `[a-z0-9-]`, must start with a letter, must not end with a hyphen, and must
 * not start with the reserved `gcp-` prefix. We always prefix `gh-` so both the
 * "starts with a letter" and "not gcp-" rules hold regardless of input.
 */
function toResourceId(base: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `gh-${slug}`.slice(0, 32).replace(/-+$/g, '');
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

export interface SetupGithubWifOptions {
  projectId: string;
  /** Numeric project number — required for the principalSet + snippet resource names. */
  projectNumber: string;
  /** SA to bind for impersonation, e.g. "ci@proj.iam.gserviceaccount.com". */
  serviceAccountEmail: string;
  /** "owner/repo" whose OIDC tokens may impersonate the SA. */
  repo: string;
  /** Pool id override. Defaults to a fixed "gh-pool" (one pool per project). */
  poolId?: string;
  /** Provider id override. Defaults to one derived from the repo. */
  providerId?: string;
  /** If set, the ready-to-paste workflow snippet is written here. */
  outputDir?: string;
}

/**
 * Set up keyless GitHub Actions auth for a service account:
 *   1. create a workload identity pool,
 *   2. create an OIDC provider trusting GitHub's issuer, locked to `repo`,
 *   3. grant the repo's federated principal `roles/iam.workloadIdentityUser`
 *      on the SA,
 *   4. return (and optionally write) a `google-github-actions/auth` snippet.
 *
 * Pool/provider creation is idempotent: an existing pool/provider (409) is
 * reused so re-running `seed --wif` against the same project doesn't fail.
 */
export async function setupGithubWif(
  auth: AuthClient,
  opts: SetupGithubWifOptions,
  log: (m: string) => void,
): Promise<WifResult> {
  const iam = google.iam({ version: 'v1', auth: auth as never });
  const { projectId, projectNumber, serviceAccountEmail, repo } = opts;
  const poolId = opts.poolId ?? 'gh-pool';
  const providerId = opts.providerId ?? toResourceId(repo);
  const locationParent = `projects/${projectId}/locations/global`;
  const poolName = `${locationParent}/workloadIdentityPools/${poolId}`;

  // 1. Workload identity pool.
  log(`Creating workload identity pool "${poolId}"…`);
  try {
    const op = await iam.projects.locations.workloadIdentityPools.create({
      parent: locationParent,
      workloadIdentityPoolId: poolId,
      requestBody: {
        displayName: 'GitHub Actions',
        description: 'Keyless CI auth created by gcp-seeder',
      },
    });
    await waitForIamOperation(
      async () => (await iam.projects.locations.workloadIdentityPools.operations.get({ name: op.data.name! })).data,
      log,
    );
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    log(`  pool "${poolId}" already exists — reusing it`);
  }

  // 2. OIDC provider, locked to the target repo via an attribute condition.
  //    Without this condition GitHub's shared issuer would let ANY repo mint a
  //    token this pool trusts — the condition is the security boundary.
  log(`Creating OIDC provider "${providerId}" for ${repo}…`);
  try {
    const op = await iam.projects.locations.workloadIdentityPools.providers.create({
      parent: poolName,
      workloadIdentityPoolProviderId: providerId,
      requestBody: {
        displayName: repo.slice(0, 32),
        oidc: { issuerUri: GITHUB_OIDC_ISSUER },
        attributeMapping: {
          'google.subject': 'assertion.sub',
          'attribute.repository': 'assertion.repository',
          'attribute.repository_owner': 'assertion.repository_owner',
        },
        attributeCondition: `assertion.repository == '${repo}'`,
      },
    });
    await waitForIamOperation(
      async () =>
        (await iam.projects.locations.workloadIdentityPools.providers.operations.get({ name: op.data.name! })).data,
      log,
    );
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    log(`  provider "${providerId}" already exists — reusing it`);
  }

  // 3. Bind the repo's federated principal to the SA (read-modify-write policy).
  const saResource = `projects/${projectId}/serviceAccounts/${serviceAccountEmail}`;
  const member = repoPrincipalSet(projectNumber, poolId, repo);
  log(`Granting ${WORKLOAD_IDENTITY_USER} to ${repo} on ${serviceAccountEmail}…`);
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
  log('✓ Workload identity binding applied');

  const providerResource = providerResourceName(projectNumber, poolId, providerId);
  const result: WifResult = {
    poolId,
    providerId,
    providerResourceName: providerResource,
    serviceAccountEmail,
    repo,
  };

  // 4. Ready-to-paste GitHub Actions snippet.
  if (opts.outputDir) {
    const file = path.join(opts.outputDir, 'github-actions-auth.yml');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, githubActionsAuthSnippet(providerResource, serviceAccountEmail), 'utf8');
    result.workflowSnippetFile = file;
    log(`✓ GitHub Actions auth snippet written to ${file}`);
  }

  return result;
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
