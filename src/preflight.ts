import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { resolveAuth } from './auth.js';
import { resolveBillingAccount, canLinkProjects, countLinkedProjects } from './billing.js';

export interface PreflightCheck {
  id: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
  fix?: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  /** True when no check is 'fail'. warn/skip do not affect this. */
  ok: boolean;
}

export interface PreflightOptions {
  /** The id you plan to create the project with. Omit to skip the id-specific checks. */
  projectId?: string;
  /** "folders/<id>" or "organizations/<id>". Omit to skip parent + org-policy checks. */
  parent?: string;
  /** A specific billing account to require, else auto-resolved like `seed`. */
  billingAccount?: string;
  /** The APIs you plan to enable — drives the billing + restrictServiceUsage checks. */
  apis?: string[];
  /** Whether the plan includes minting a downloadable SA key (drives the key-creation org-policy check). */
  wantsServiceAccountKey?: boolean;
  /** Whether the plan includes an OAuth client (drives the oauth-org check). */
  wantsOAuthClient?: boolean;
  /** Pre-authorized cloud-platform auth client. Falls back to ADC. */
  auth?: AuthClient;
  /** Receives progress lines. Default: no-op. */
  logger?: (message: string) => void;
  /** Reference "now" for any time-based math. Injectable for tests; defaults to the wall clock. */
  now?: Date;
}

/**
 * APIs that require a linked billing account to actually function (most
 * non-Workspace APIs). Used by the "billing" check to decide whether a
 * missing/unlinkable billing account is a `fail` or just moot.
 */
export const BILLING_REQUIRED_APIS = new Set<string>([
  'aiplatform.googleapis.com',
  'run.googleapis.com',
  'cloudfunctions.googleapis.com',
  'bigquery.googleapis.com',
  'storage.googleapis.com',
  'pubsub.googleapis.com',
  'firestore.googleapis.com',
  'compute.googleapis.com',
  'speech.googleapis.com',
  'texttospeech.googleapis.com',
  'vision.googleapis.com',
  'translate.googleapis.com',
  'generativelanguage.googleapis.com',
]);

const ALL_CHECK_IDS = ['auth', 'project-id', 'quota', 'parent', 'billing', 'org-policy', 'bootstrap-apis', 'oauth-org'];

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 1. auth — report the calling principal. Never print tokens; email only. */
async function checkAuth(auth: AuthClient): Promise<PreflightCheck> {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: auth as never });
    const { data } = await oauth2.userinfo.get();
    if (!data.email) throw new Error('userinfo response had no email');
    return { id: 'auth', status: 'pass', detail: `Authenticated as ${data.email}.` };
  } catch (err) {
    return {
      id: 'auth',
      status: 'skip',
      detail: `Could not determine the calling principal (insufficient scope/permission, or unsupported credential type): ${errMsg(err)}`,
    };
  }
}

/** 2. project-id — shape + whether it (or its soft-deleted ghost) already exists. */
async function checkProjectId(auth: AuthClient, projectId: string | undefined): Promise<PreflightCheck> {
  if (!projectId) {
    return { id: 'project-id', status: 'skip', detail: 'No project id given; one will be generated at seed time.' };
  }
  if (!/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/.test(projectId)) {
    return {
      id: 'project-id',
      status: 'fail',
      detail: `"${projectId}" is not a valid GCP project id (6-30 lowercase letters, digits, hyphens; must start with a letter).`,
    };
  }
  try {
    const crm = google.cloudresourcemanager({ version: 'v3', auth: auth as never });
    const { data } = await crm.projects.search({ query: `id:${projectId}` });
    const match = (data.projects ?? []).find((p) => p.projectId === projectId);
    if (!match) {
      return {
        id: 'project-id',
        status: 'warn',
        detail: `"${projectId}" is not among your projects. Google gives no availability API — a 409 at create means someone else owns it, or it was deleted.`,
      };
    }
    if (match.state === 'DELETE_REQUESTED') {
      let until: string | undefined;
      if (match.deleteTime) {
        const deleteMs = Date.parse(match.deleteTime);
        if (!Number.isNaN(deleteMs)) until = new Date(deleteMs + 30 * 86_400_000).toISOString();
      }
      return {
        id: 'project-id',
        status: 'warn',
        detail:
          `"${projectId}" is soft-deleted` +
          (until ? ` and counts against quota until ${until}` : '') +
          '; the id can never be reused.',
      };
    }
    return {
      id: 'project-id',
      status: 'fail',
      detail: `"${projectId}" already belongs to you (state: ${match.state ?? 'ACTIVE'}). Pick another id.`,
    };
  } catch (err) {
    return { id: 'project-id', status: 'skip', detail: `Could not search for "${projectId}": ${errMsg(err)}` };
  }
}

/** 3. quota — heuristic count of ACTIVE + DELETE_REQUESTED projects the caller owns. */
async function checkQuota(auth: AuthClient): Promise<PreflightCheck> {
  try {
    const crm = google.cloudresourcemanager({ version: 'v3', auth: auth as never });
    let count = 0;
    let pageToken: string | undefined;
    do {
      const { data } = await crm.projects.search({ pageSize: 200, pageToken });
      for (const p of data.projects ?? []) {
        if (p.state === 'ACTIVE' || p.state === 'DELETE_REQUESTED') count++;
      }
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);

    if (count >= 25) {
      return {
        id: 'quota',
        status: 'warn',
        detail: `${count} project(s) counted (ACTIVE + DELETE_REQUESTED, heuristic). The default project-creation quota is ~30, and soft-deleted projects still count for 30 days.`,
        fix: 'https://support.google.com/code/contact/project_quota_increase',
      };
    }
    return { id: 'quota', status: 'pass', detail: `${count} project(s) counted toward quota (heuristic).` };
  } catch (err) {
    return { id: 'quota', status: 'skip', detail: `Could not count projects: ${errMsg(err)}` };
  }
}

/** 4. parent — can the caller create projects under the given folder/org. */
async function checkParent(auth: AuthClient, parent: string | undefined): Promise<PreflightCheck> {
  if (!parent) return { id: 'parent', status: 'skip', detail: 'No --parent given.' };
  const isFolder = parent.startsWith('folders/');
  const isOrg = parent.startsWith('organizations/');
  if (!isFolder && !isOrg) {
    return { id: 'parent', status: 'fail', detail: `"${parent}" must look like "folders/<id>" or "organizations/<id>".` };
  }
  try {
    const crm = google.cloudresourcemanager({ version: 'v3', auth: auth as never });
    const requestBody = { permissions: ['resourcemanager.projects.create'] };
    const { data } = isFolder
      ? await crm.folders.testIamPermissions({ resource: parent, requestBody })
      : await crm.organizations.testIamPermissions({ resource: parent, requestBody });
    const has = (data.permissions ?? []).includes('resourcemanager.projects.create');
    return has
      ? { id: 'parent', status: 'pass', detail: `Can create projects under ${parent}.` }
      : {
          id: 'parent',
          status: 'fail',
          detail: `Missing resourcemanager.projects.create on ${parent}.`,
          fix: 'Grant roles/resourcemanager.projectCreator (or a broader role that includes it) on the parent.',
        };
  } catch (err) {
    return { id: 'parent', status: 'skip', detail: `Could not test permissions on ${parent}: ${errMsg(err)}` };
  }
}

/** 5. billing — via resolveBillingAccount + canLinkProjects from billing.ts. */
async function checkBilling(
  auth: AuthClient,
  billingAccount: string | undefined,
  apis: string[],
): Promise<PreflightCheck> {
  const requestedNeedsBilling = apis.filter((a) => BILLING_REQUIRED_APIS.has(a));
  try {
    const { account, candidates } = await resolveBillingAccount(auth, billingAccount);
    if (!account) {
      if (requestedNeedsBilling.length === 0) {
        return {
          id: 'billing',
          status: 'pass',
          detail: 'No billing account resolved, but none of the requested APIs require one.',
        };
      }
      const detail =
        candidates.length > 1
          ? `Several billing accounts are visible (${candidates.map((c) => c.name).join(', ')}) and none was specified.`
          : 'No linkable billing account was found.';
      return {
        id: 'billing',
        status: 'fail',
        detail: `${detail} These requested APIs need billing: ${requestedNeedsBilling.join(', ')}.`,
        fix: 'Pass --billing-account <id>, or link/create one at https://console.cloud.google.com/billing',
      };
    }
    const canLink = await canLinkProjects(auth, account);
    if (!canLink) {
      return {
        id: 'billing',
        status: 'fail',
        detail: `Cannot link billing account ${account}: missing billing.resourceAssociations.create.`,
        fix: 'Grant roles/billing.user ON THE BILLING ACCOUNT itself (an org-level grant is not enough when the account lives outside the org).',
      };
    }
    // The per-account project cap (default 5) only fails at link time with an
    // opaque precondition error — count ahead so the run doesn't die half-way.
    const linked = await countLinkedProjects(auth, account).catch(() => undefined);
    if (linked !== undefined && linked >= DEFAULT_PROJECTS_PER_BILLING_ACCOUNT) {
      return {
        id: 'billing',
        status: 'warn',
        detail: `Billing account ${account} already has ${linked} linked project(s); the default cap is ${DEFAULT_PROJECTS_PER_BILLING_ACCOUNT}, so linking may fail with "Precondition check failed" unless the quota was raised.`,
        fix: `Unlink an unused project, pick another account, or request an increase: https://console.cloud.google.com/billing/${account.replace('billingAccounts/', '')}/manage`,
      };
    }
    return {
      id: 'billing',
      status: 'pass',
      detail: `Billing account ${account} is resolved and linkable${linked !== undefined ? ` (${linked} project(s) linked)` : ''}.`,
    };
  } catch (err) {
    return { id: 'billing', status: 'skip', detail: `Could not resolve/verify billing: ${errMsg(err)}` };
  }
}

interface EffectivePolicyLike {
  spec?: { rules?: Array<{ enforce?: boolean | null }> } | null;
}

function isEnforced(policy: EffectivePolicyLike | undefined): boolean {
  return Boolean(policy?.spec?.rules?.some((r) => r.enforce === true));
}

function hasAnyRule(policy: EffectivePolicyLike | undefined): boolean {
  return Boolean(policy?.spec?.rules && policy.spec.rules.length > 0);
}

/** 6. org-policy — the constraints most likely to surprise seed/harden. */
async function checkOrgPolicy(
  auth: AuthClient,
  parent: string | undefined,
  wantsServiceAccountKey: boolean,
  apis: string[],
): Promise<PreflightCheck> {
  if (!parent) return { id: 'org-policy', status: 'skip', detail: 'No --parent given; org policy cannot be evaluated.' };
  try {
    const orgpolicy = google.orgpolicy({ version: 'v2', auth: auth as never });
    const isFolder = parent.startsWith('folders/');
    const policies = isFolder ? orgpolicy.folders.policies : orgpolicy.organizations.policies;

    const getEffective = async (constraint: string): Promise<EffectivePolicyLike | undefined> => {
      const { data } = await policies.getEffectivePolicy({ name: `${parent}/policies/${constraint}` });
      return data as EffectivePolicyLike;
    };

    const notes: string[] = [];
    let status: PreflightCheck['status'] = 'pass';
    let fix: string | undefined;

    const keyCreation = await getEffective('iam.disableServiceAccountKeyCreation');
    if (isEnforced(keyCreation) && wantsServiceAccountKey) {
      status = 'fail';
      notes.push('iam.disableServiceAccountKeyCreation is enforced — SA key creation will be blocked.');
      fix = 'Use workload identity federation (--wif) instead of a downloaded key.';
    }

    const defaultNetwork = await getEffective('compute.skipDefaultNetworkCreation');
    if (isEnforced(defaultNetwork)) {
      notes.push('compute.skipDefaultNetworkCreation is enforced — the harden-defaults default-network step is unnecessary.');
    }

    const autoGrants = await getEffective('iam.automaticIamGrantsForDefaultServiceAccounts');
    if (isEnforced(autoGrants)) {
      notes.push('iam.automaticIamGrantsForDefaultServiceAccounts is enforced.');
    }

    const restrictServiceUsage = await getEffective('gcp.restrictServiceUsage');
    if (hasAnyRule(restrictServiceUsage)) {
      if (status !== 'fail') status = 'warn';
      notes.push(
        `gcp.restrictServiceUsage has a policy set — verify it allows: ${apis.length ? apis.join(', ') : '(no APIs requested)'}.`,
      );
    }

    return {
      id: 'org-policy',
      status,
      detail: notes.length ? notes.join(' ') : 'No blocking org policies detected on the relevant constraints.',
      ...(fix ? { fix } : {}),
    };
  } catch (err) {
    return { id: 'org-policy', status: 'skip', detail: `Could not read org policy on ${parent}: ${errMsg(err)}` };
  }
}

/** 7. bootstrap-apis — does ADC's own quota project have the APIs preflight/seed itself need. */
async function checkBootstrapApis(auth: AuthClient): Promise<PreflightCheck> {
  const quotaProjectId = (auth as { quotaProjectId?: string | null }).quotaProjectId ?? undefined;
  if (!quotaProjectId) {
    return { id: 'bootstrap-apis', status: 'skip', detail: 'No quota project attached to these credentials.' };
  }
  try {
    const su = google.serviceusage({ version: 'v1', auth: auth as never });
    const required = ['serviceusage.googleapis.com', 'cloudresourcemanager.googleapis.com'];
    const missing: string[] = [];
    for (const api of required) {
      const { data } = await su.services.get({ name: `projects/${quotaProjectId}/services/${api}` });
      if (data.state !== 'ENABLED') missing.push(api);
    }
    return missing.length
      ? {
          id: 'bootstrap-apis',
          status: 'fail',
          detail: `Quota project ${quotaProjectId} is missing: ${missing.join(', ')}.`,
        }
      : { id: 'bootstrap-apis', status: 'pass', detail: `Quota project ${quotaProjectId} has the bootstrap APIs enabled.` };
  } catch (err) {
    return { id: 'bootstrap-apis', status: 'skip', detail: `Could not check quota-project APIs: ${errMsg(err)}` };
  }
}

/**
 * Read-only preflight for the things that fail opaquely *after* resources
 * already exist: quota, billing permission, org policy, and burned project
 * ids. Every check is independent, catches its own errors, and reports
 * `skip` (never throws) when the caller lacks permission for that specific
 * check. This function itself never throws for a Google/API error — only
 * for a genuinely bad call (e.g. a non-Error auth injection blowing up
 * `resolveAuth` in a way that isn't a credentials problem at all).
 */
/** Google's default projects-per-billing-account quota. */
/** Organizations the caller can see, as { name: "organizations/<id>", displayName }. */
export async function findAccessibleOrganizations(auth: AuthClient): Promise<{ name: string; displayName?: string }[]> {
  const crm = google.cloudresourcemanager({ version: 'v3', auth: auth as never });
  const { data } = await crm.organizations.search({});
  return (data.organizations ?? [])
    .filter((o) => o.name && o.state !== 'DELETE_REQUESTED')
    .map((o) => ({ name: o.name!, displayName: o.displayName ?? undefined }));
}

/**
 * 8. oauth-org — an Internal OAuth consent screen needs the *project* inside a
 * Cloud organization; a Workspace login alone isn't enough. Warn before
 * creating an org-less project that asks for an OAuth client.
 */
async function checkOAuthOrg(auth: AuthClient, parent: string | undefined, wantsOAuthClient: boolean): Promise<PreflightCheck> {
  if (!wantsOAuthClient) return { id: 'oauth-org', status: 'skip', detail: 'No OAuth client requested.' };
  if (parent) return { id: 'oauth-org', status: 'pass', detail: `Project will be created under ${parent}.` };
  try {
    const orgs = await findAccessibleOrganizations(auth);
    if (orgs.length === 0) {
      return {
        id: 'oauth-org',
        status: 'warn',
        detail: 'No --parent and no Cloud organization visible to you: automatic OAuth client creation will likely fail.',
        fix: 'Personal accounts must finish the consent screen in the console; Workspace users should seed with --parent organizations/<id>.',
      };
    }
    const list = orgs.map((o) => `${o.name}${o.displayName ? ` (${o.displayName})` : ''}`).join(', ');
    return {
      id: 'oauth-org',
      status: 'warn',
      detail: `No --parent, so the project will be org-less and can't get an Internal consent screen. Visible org(s): ${list}.`,
      fix: `Re-run with --parent ${orgs[0]!.name} (or a folder under it).`,
    };
  } catch (err) {
    return { id: 'oauth-org', status: 'skip', detail: `Could not list organizations: ${errMsg(err)}` };
  }
}

export const DEFAULT_PROJECTS_PER_BILLING_ACCOUNT = 5;

export async function preflight(options: PreflightOptions = {}): Promise<PreflightReport> {
  const log = options.logger ?? (() => {});
  const apis = options.apis ?? [];

  let auth: AuthClient;
  try {
    auth = await resolveAuth(options.auth);
  } catch (err) {
    // No credentials means nothing could be checked — that is a blocking
    // failure, not a pass (a CI/agent consumer must not read `ok: true` here).
    const detail = `Could not resolve credentials: ${errMsg(err)}`;
    log(detail);
    return {
      checks: [
        { id: 'auth', status: 'fail', detail, fix: 'Run `gcp-seeder init` (or `gcloud auth application-default login`) and retry.' },
        ...ALL_CHECK_IDS.filter((id) => id !== 'auth').map((id) => ({ id, status: 'skip' as const, detail: 'Skipped: no credentials.' })),
      ],
      ok: false,
    };
  }

  log('Running preflight checks…');
  const checks = await Promise.all([
    checkAuth(auth),
    checkProjectId(auth, options.projectId),
    checkQuota(auth),
    checkParent(auth, options.parent),
    checkBilling(auth, options.billingAccount, apis),
    checkOrgPolicy(auth, options.parent, options.wantsServiceAccountKey ?? false, apis),
    checkBootstrapApis(auth),
    checkOAuthOrg(auth, options.parent, options.wantsOAuthClient ?? false),
  ]);

  return { checks, ok: !checks.some((c) => c.status === 'fail') };
}
