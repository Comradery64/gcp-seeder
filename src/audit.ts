import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { resolveAuth } from './auth.js';
import { listWifPools } from './wif.js';
import type {
  AuditOptions,
  AuditReport,
  KeyAudit,
  ProjectAudit,
  ServiceAccountAudit,
} from './types.js';

const DEFAULT_FLAG_PATTERNS = ['gyb-project-*', 'seed-*'];

/** Convert a `*`-glob to an anchored regex. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Run `fn` over `items` with a bounded number of concurrent workers, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

async function listProjects(auth: AuthClient): Promise<Array<Record<string, string>>> {
  const crm = google.cloudresourcemanager({ version: 'v1', auth: auth as never });
  const out: Array<Record<string, string>> = [];
  let pageToken: string | undefined;
  do {
    const { data } = await crm.projects.list({ pageSize: 200, pageToken });
    for (const p of data.projects ?? []) out.push(p as Record<string, string>);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function auditProject(
  auth: AuthClient,
  project: Record<string, string>,
  flagPatterns: RegExp[],
): Promise<ProjectAudit> {
  const projectId = project.projectId!;
  const audit: ProjectAudit = {
    projectId,
    projectNumber: project.projectNumber,
    name: project.name,
    lifecycleState: project.lifecycleState,
    createTime: project.createTime,
    orphanCandidate: flagPatterns.some((rx) => rx.test(projectId)),
    accessible: true,
    serviceAccounts: [],
    wifPools: [],
  };

  // Only ACTIVE projects can be meaningfully scanned for service accounts.
  if (audit.lifecycleState && audit.lifecycleState !== 'ACTIVE') return audit;

  // Keyless-auth surface: list any workload identity pools. Independent of the
  // SA scan and best-effort — the WIF API may be disabled or access-restricted,
  // in which case we simply report no pools rather than failing the whole scan.
  try {
    audit.wifPools = await listWifPools(auth, projectId);
  } catch {
    // WIF API off / insufficient permission — leave wifPools empty.
  }

  const iam = google.iam({ version: 'v1', auth: auth as never });
  try {
    const accounts: Array<Record<string, unknown>> = [];
    let token: string | undefined;
    do {
      const { data } = await iam.projects.serviceAccounts.list({
        name: `projects/${projectId}`,
        pageSize: 100,
        pageToken: token,
      });
      for (const a of data.accounts ?? []) accounts.push(a as Record<string, unknown>);
      token = data.nextPageToken ?? undefined;
    } while (token);

    for (const sa of accounts) {
      const keys: KeyAudit[] = [];
      try {
        const { data } = await iam.projects.serviceAccounts.keys.list({
          name: sa.name as string,
          keyTypes: ['USER_MANAGED'],
        });
        for (const k of data.keys ?? []) {
          keys.push({
            keyId: (k.name ?? '').split('/').pop() ?? '',
            validAfterTime: k.validAfterTime ?? undefined,
            validBeforeTime: k.validBeforeTime ?? undefined,
          });
        }
      } catch {
        // key listing can fail independently (rare); leave keys empty.
      }
      const entry: ServiceAccountAudit = {
        email: sa.email as string,
        clientId: (sa.uniqueId as string) ?? '',
        disabled: Boolean(sa.disabled),
        userManagedKeys: keys,
      };
      audit.serviceAccounts.push(entry);
    }
  } catch {
    // Most commonly: caller lacks iam.serviceAccounts.list on this project.
    audit.accessible = false;
  }
  return audit;
}

/**
 * Read-only audit of every project the caller's credentials can see: flags orphan
 * candidates, finds every static (user-managed) service-account key, and surfaces the
 * client ids whose domain-wide-delegation grants should be verified by hand.
 *
 * Strictly read-only — it never mutates anything.
 */
export async function auditCloud(options: AuditOptions = {}): Promise<AuditReport> {
  const log = options.logger ?? (() => {});
  const auth = await resolveAuth(options.auth);
  const flagPatterns = (options.flagPatterns ?? DEFAULT_FLAG_PATTERNS).map(globToRegex);

  let projects: Array<Record<string, string>>;
  if (options.projectIds?.length) {
    projects = options.projectIds.map((projectId) => ({ projectId }));
  } else {
    log('Listing projects…');
    projects = await listProjects(auth);
  }
  log(`Scanning ${projects.length} project(s)…`);

  const audits = await mapLimit(projects, options.concurrency ?? 8, (p) =>
    auditProject(auth, p, flagPatterns),
  );

  const staticKeys: AuditReport['staticKeys'] = [];
  const dwdSeen = new Set<string>();
  const dwdCheckList: AuditReport['dwdCheckList'] = [];
  const wifProviders: AuditReport['wifProviders'] = [];
  const warnings: string[] = [];

  for (const a of audits) {
    if (!a.accessible) warnings.push(`No access to service accounts in ${a.projectId} (skipped).`);
    for (const pool of a.wifPools) {
      for (const prov of pool.providers) {
        wifProviders.push({
          projectId: a.projectId,
          poolId: pool.poolId,
          providerId: prov.providerId,
          issuerUri: prov.issuerUri,
          attributeCondition: prov.attributeCondition,
        });
      }
    }
    for (const sa of a.serviceAccounts) {
      for (const k of sa.userManagedKeys) {
        staticKeys.push({
          projectId: a.projectId,
          serviceAccount: sa.email,
          keyId: k.keyId,
          createdAt: k.validAfterTime,
        });
      }
      // DWD is inert without a key, so only flag SAs that actually hold one.
      if (sa.userManagedKeys.length > 0 && sa.clientId && !dwdSeen.has(sa.clientId)) {
        dwdSeen.add(sa.clientId);
        dwdCheckList.push({ projectId: a.projectId, serviceAccount: sa.email, clientId: sa.clientId });
      }
    }
  }

  return { scannedProjects: projects.length, projects: audits, staticKeys, dwdCheckList, wifProviders, warnings };
}
