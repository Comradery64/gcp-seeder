import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { BOOTSTRAP_APIS } from './apis.js';
import { resolveAuth } from './auth.js';
import { buildSeedLabels } from './labels.js';
import { setupGithubWif, WIF_APIS } from './wif.js';
import type { SeedOptions, SeedResult, ServiceAccountSpec, WifResult } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dedupe = (xs: string[]) => [...new Set(xs)];

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Generate a globally-unique, GCP-valid project id.
 * Rules: 6-30 chars, lowercase letters/digits/hyphens, must start with a letter.
 */
export function generateProjectId(prefix = 'seed'): string {
  const rand = randomBytes(6).toString('hex'); // 12 hex chars
  const id = `${prefix}-${rand}`.toLowerCase().slice(0, 30);
  return id;
}

// GCP project display names: 4-30 chars; letters, digits, space, hyphen,
// single/double quote, exclamation point. Anything else (e.g. parentheses)
// is rejected by the API with a cryptic error, so we check up front.
const DISPLAY_NAME_RE = /^[A-Za-z0-9'"! -]{4,30}$/;

function assertValidDisplayName(name: string): void {
  if (!DISPLAY_NAME_RE.test(name)) {
    throw new Error(
      `Invalid project display name ${JSON.stringify(name)}. ` +
        'It must be 4-30 characters using only letters, digits, spaces, hyphens, ' +
        'single/double quotes, and exclamation points (no parentheses, commas, etc.).',
    );
  }
}

/** Poll a long-running operation until done. Works across CRM/ServiceUsage/IAM. */
async function waitForOperation(
  getOp: () => Promise<{ done?: boolean | null; error?: unknown; response?: unknown; name?: string | null }>,
  log: (m: string) => void,
  { timeoutMs = 180_000, intervalMs = 3_000 } = {},
): Promise<{ response?: unknown }> {
  const start = Date.now();
  // Google recommends waiting before the first poll.
  await sleep(intervalMs);
  for (;;) {
    const op = await getOp();
    if (op.done) {
      if (op.error) {
        throw new Error(`Operation failed: ${JSON.stringify(op.error)}`);
      }
      return op;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for Google Cloud operation to complete.');
    }
    log('  …still working');
    await sleep(intervalMs);
  }
}

async function createProject(
  auth: AuthClient,
  projectId: string,
  displayName: string,
  parent: string | undefined,
  labels: Record<string, string>,
  log: (m: string) => void,
): Promise<string> {
  const crm = google.cloudresourcemanager({ version: 'v3', auth: auth as never });
  log(`Creating project "${projectId}"…`);
  const create = await crm.projects.create({
    requestBody: { projectId, displayName, parent, labels },
  });
  const done = await waitForOperation(
    async () => (await crm.operations.get({ name: create.data.name! })).data,
    log,
  );
  // The completed operation's response is the Project: { name: "projects/<number>" }
  const projectResource = done.response as { name?: string } | undefined;
  const projectNumber = projectResource?.name?.split('/')[1] ?? '';
  log(`✓ Project created (number ${projectNumber || 'unknown'})`);
  return projectNumber;
}

async function enableApis(
  auth: AuthClient,
  projectId: string,
  apis: string[],
  log: (m: string) => void,
): Promise<string[]> {
  const su = google.serviceusage({ version: 'v1', auth: auth as never });
  // batchEnable accepts at most 20 services per call.
  for (const batch of chunk(apis, 20)) {
    log(`Enabling APIs: ${batch.join(', ')}`);
    const op = await su.services.batchEnable({
      parent: `projects/${projectId}`,
      requestBody: { serviceIds: batch },
    });
    await waitForOperation(
      async () => (await su.operations.get({ name: op.data.name! })).data,
      log,
    );
  }
  log(`✓ Enabled ${apis.length} API(s)`);
  return apis;
}

/**
 * True when key creation failed because the org forbids it (org policy
 * `iam.disableServiceAccountKeyCreation`). Common in hardened Workspace orgs.
 * The SA itself is created fine — only the downloadable key is blocked.
 */
function isKeyCreationBlocked(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /key creation is not allowed|disableServiceAccountKeyCreation/i.test(msg);
}

/** Create the service account (no key). Returns its email + OAuth client id. */
async function createServiceAccount(
  auth: AuthClient,
  projectId: string,
  spec: ServiceAccountSpec,
  log: (m: string) => void,
): Promise<{ email: string; clientId: string; resourceName: string }> {
  const iam = google.iam({ version: 'v1', auth: auth as never });
  log(`Creating service account "${spec.id}"…`);
  const sa = await iam.projects.serviceAccounts.create({
    name: `projects/${projectId}`,
    requestBody: {
      accountId: spec.id,
      serviceAccount: { displayName: spec.displayName },
    },
  });
  // uniqueId is the OAuth client id a domain-wide-delegation grant is keyed on.
  return { email: sa.data.email!, clientId: sa.data.uniqueId ?? '', resourceName: sa.data.name! };
}

/** Mint a JSON key for an existing SA and write it to disk. Returns the file path. */
async function mintServiceAccountKey(
  auth: AuthClient,
  resourceName: string,
  outputDir: string,
  keyFileName: string,
  log: (m: string) => void,
): Promise<string> {
  const iam = google.iam({ version: 'v1', auth: auth as never });
  // Newly created SAs can take a moment to be consistent; retry key creation on 404.
  let keyData: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const key = await iam.projects.serviceAccounts.keys.create({
        name: resourceName,
        requestBody: {
          privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE',
          keyAlgorithm: 'KEY_ALG_RSA_2048',
        },
      });
      keyData = key.data.privateKeyData ?? undefined;
      break;
    } catch (err) {
      const status = (err as { code?: number }).code;
      if (status === 404 && attempt < 4) {
        await sleep(3_000);
        continue;
      }
      throw err;
    }
  }
  if (!keyData) throw new Error('Service account created but no key material was returned.');

  // privateKeyData is base64 of the complete JSON key file.
  const keyFile = path.join(outputDir, keyFileName);
  await writeSecret(keyFile, Buffer.from(keyData, 'base64'));
  log(`✓ Service account key written to ${keyFile}`);
  return keyFile;
}

/**
 * Create an OAuth consent screen ("brand") and an OAuth client, then write a
 * client_secret.json in the installed-app shape GYB/GAM use.
 *
 * NOTE: this uses the IAP brands API — the same workaround GYB relies on. It
 * reliably succeeds only for Workspace ("Internal") org projects. For personal
 * gmail.com accounts Google usually rejects programmatic brand creation; in
 * that case we throw and the caller records a warning telling the user to
 * finish the consent screen by hand in the console.
 */
async function createOAuthClient(
  auth: AuthClient,
  projectId: string,
  title: string,
  supportEmail: string,
  outputDir: string,
  log: (m: string) => void,
): Promise<{ clientSecretsFile: string }> {
  const iap = google.iap({ version: 'v1', auth: auth as never });
  log('Configuring OAuth consent screen…');
  try {
    await iap.projects.brands.create({
      parent: `projects/${projectId}`,
      requestBody: { applicationTitle: title, supportEmail },
    });
  } catch {
    // A brand may already exist (or creation is org-restricted) — fall through
    // and try to list/use whatever brand is present.
  }

  const brands = await iap.projects.brands.list({ parent: `projects/${projectId}` });
  const brand = brands.data.brands?.[0];
  if (!brand?.name) {
    throw new Error(
      'No OAuth consent screen (brand) is available for this project. ' +
        'Personal Google accounts must configure the consent screen manually in the console.',
    );
  }

  log('Creating OAuth client…');
  const client = await iap.projects.brands.identityAwareProxyClients.create({
    parent: brand.name,
    requestBody: { displayName: title },
  });
  // client.name = projects/<n>/brands/<n>/identityAwareProxyClients/<CLIENT_ID>
  const clientId = client.data.name?.split('/').pop() ?? '';
  const clientSecret = client.data.secret ?? '';

  const clientSecretsFile = path.join(outputDir, 'client_secret.json');
  const payload = {
    installed: {
      client_id: clientId,
      client_secret: clientSecret,
      project_id: projectId,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      redirect_uris: ['http://localhost'],
    },
  };
  await writeSecret(clientSecretsFile, Buffer.from(JSON.stringify(payload, null, 2)));
  log(`✓ OAuth client written to ${clientSecretsFile}`);
  return { clientSecretsFile };
}

/** Write a sensitive file with owner-only (0600) permissions. */
async function writeSecret(filePath: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data, { mode: 0o600 });
}

/**
 * Bootstrap a complete Google Cloud project: create it, enable APIs, and
 * generate the requested credential artifacts. This is the library entry point.
 */
export async function seedProject(options: SeedOptions): Promise<SeedResult> {
  const log = options.logger ?? ((m: string) => console.log(m));
  const auth = await resolveAuth(options.auth);
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'credentials');

  const projectId = options.projectId ?? generateProjectId();
  const displayName = options.displayName ?? projectId;
  assertValidDisplayName(displayName);

  if (options.credentials.oauthClient && !options.supportEmail) {
    throw new Error('supportEmail is required when credentials.oauthClient is true.');
  }

  // WIF needs a service account to bind the federated principal to. Fail early
  // (before creating anything) rather than after a project exists.
  const willCreateSa = Boolean(options.serviceAccounts?.length) || options.credentials.serviceAccount;
  if (options.wif && !willCreateSa) {
    throw new Error(
      'options.wif requires at least one service account to bind. ' +
        'Pass credentials.serviceAccount: true or an explicit serviceAccounts list.',
    );
  }

  // Build labels up front so an invalid --ttl fails before anything is created.
  const labels = buildSeedLabels({ ttl: options.ttl });

  const projectNumber = await createProject(auth, projectId, displayName, options.parent, labels, log);

  const apisToEnable = dedupe([
    ...BOOTSTRAP_APIS,
    ...(options.wif ? WIF_APIS : []),
    ...options.apis,
  ]);
  const enabledApis = await enableApis(auth, projectId, apisToEnable, log);

  const result: SeedResult = {
    projectId,
    projectNumber,
    enabledApis,
    labels,
    warnings: [],
  };

  // Resolve which service accounts to mint. An explicit `serviceAccounts` list
  // wins; otherwise `credentials.serviceAccount: true` implies one default SA.
  const saSpecs: ServiceAccountSpec[] = [...(options.serviceAccounts ?? [])];
  if (options.credentials.serviceAccount && saSpecs.length === 0) {
    saSpecs.push({
      id: `seeder-sa-${randomBytes(2).toString('hex')}`,
      displayName: 'GCP Seeder Service Account',
      keyFile: 'service-account.json',
    });
  }

  if (saSpecs.length) {
    result.serviceAccounts = [];
    result.dwdGrants = [];
    for (const spec of saSpecs) {
      const sa = await createServiceAccount(auth, projectId, spec, log);
      // The SA is created; a downloadable key can still be blocked by org policy.
      // Don't discard the SA over that — record a warning and carry on (like the
      // OAuth-client path). The SA + its client id are still returned.
      let keyFile: string | null = null;
      try {
        keyFile = await mintServiceAccountKey(auth, sa.resourceName, outputDir, spec.keyFile, log);
      } catch (err) {
        if (isKeyCreationBlocked(err)) {
          result.warnings.push(
            `Service account ${sa.email} was created, but key creation is blocked by an org ` +
              `policy (iam.disableServiceAccountKeyCreation). For CI, prefer keyless auth: re-run ` +
              `with --wif github:owner/repo to federate GitHub Actions instead of a key. ` +
              `Domain-wide delegation still requires a key — ask an org admin to grant an ` +
              `exception for project ${projectId}, then mint a key for ${sa.email}.`,
          );
        } else {
          throw err;
        }
      }
      result.serviceAccounts.push({ email: sa.email, keyFile, clientId: sa.clientId });
      if (spec.dwdScopes?.length) {
        result.dwdGrants.push({
          serviceAccountEmail: sa.email,
          clientId: sa.clientId,
          scopes: spec.dwdScopes,
        });
      }
    }
    // Back-compat: expose the first SA that actually has a key on the legacy field.
    const firstWithKey = result.serviceAccounts.find((s) => s.keyFile);
    if (firstWithKey) result.serviceAccount = { email: firstWithKey.email, keyFile: firstWithKey.keyFile! };

    // Keyless auth: federate the target repo to each created SA. This is the
    // preferred path when key creation is blocked, and works regardless.
    if (options.wif) {
      const wifResults: WifResult[] = [];
      for (const sa of result.serviceAccounts) {
        // Don't let a late WIF failure (e.g. missing setIamPolicy permission, or
        // IAM still propagating) throw and leave a half-provisioned project — the
        // project, SA, and any created pool/provider are kept; record an
        // actionable warning. Re-running `seed --wif` is idempotent and finishes.
        try {
          wifResults.push(
            await setupGithubWif(
              auth,
              {
                projectId,
                projectNumber,
                serviceAccountEmail: sa.email,
                repo: options.wif.repo,
                outputDir,
              },
              log,
            ),
          );
        } catch (err) {
          result.warnings.push(
            `Workload Identity Federation for ${sa.email} (repo ${options.wif.repo}) did not fully ` +
              `complete: ${(err as Error).message} The project and service account are kept, along ` +
              `with any pool/provider already created. Re-run the same \`seed --wif\` command to ` +
              `finish (it's idempotent), or grant roles/iam.workloadIdentityUser to the repo's ` +
              `principalSet on ${sa.email} by hand.`,
          );
        }
      }
      if (wifResults.length) result.wif = wifResults;
    }
  }

  if (options.credentials.oauthClient) {
    try {
      result.oauthClient = await createOAuthClient(
        auth,
        projectId,
        options.consentScreenTitle ?? displayName,
        options.supportEmail!,
        outputDir,
        log,
      );
    } catch (err) {
      result.warnings.push(
        `Could not create OAuth client automatically: ${(err as Error).message} ` +
          `Finish it manually at https://console.cloud.google.com/apis/credentials?project=${projectId}`,
      );
    }
  }

  return result;
}
