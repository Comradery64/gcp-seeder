import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { resolveAuth } from './auth.js';
import { isSeederLabeled } from './labels.js';
import { deleteWifPool, listWifPools } from './wif.js';
import { BOOTSTRAP_APIS } from './apis.js';
import { listLiens, removeLiens as removeProjectLiens, type LienInfo } from './liens.js';
import type { DestroyOptions, DestroyResult, ProjectDestroyResult } from './types.js';

const DEFAULT_FLAG_PATTERNS = ['gyb-project-*', 'seed-*'];

// `--empty` never disables the bootstrap set (the seeder needs it to operate
// on the project again later) nor sts/iamcredentials (the WIF token-exchange
// APIs — `iamcredentials` is already in BOOTSTRAP_APIS, `sts` is listed
// explicitly per the v0.5 plan).
const EMPTY_MODE_KEEP_APIS = new Set([...BOOTSTRAP_APIS, 'sts.googleapis.com', 'iamcredentials.googleapis.com']);

// GCP auto-creates these two service accounts; deleting the default compute SA
// is a known, unrecoverable-after-30-days trap, so `--empty` never touches them.
function isDefaultServiceAccount(email: string): boolean {
  return /^\d+-compute@developer\.gserviceaccount\.com$/.test(email) || /@appspot\.gserviceaccount\.com$/.test(email);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a long-running serviceusage operation until done (mirrors seeder.ts's helper). */
async function waitForServiceOp(
  getOp: () => Promise<{ done?: boolean | null; error?: unknown }>,
  log: (m: string) => void,
  { timeoutMs = 180_000, intervalMs = 3_000 } = {},
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
      throw new Error('Timed out waiting for a Google Cloud operation to complete.');
    }
    log('  …still working');
    await sleep(intervalMs);
  }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * `DestroyOptions` plus the liens + `--empty` additions. Kept local to this
 * file (per the v0.5 architecture rule) rather than editing `src/types.ts`;
 * the integration pass should fold these onto the shared type.
 */
export interface DestroyOptionsExt extends DestroyOptions {
  /** Remove any liens found on a project before deleting it. Default false. */
  removeLiens?: boolean;
  /**
   * "Empty" mode: do everything `keysOnly` does (revoke keys + tear down WIF
   * pools), then also delete every user-managed service account, delete the
   * gcp-seeder-owned budget (if any), and disable every enabled non-bootstrap
   * API. The project itself (and its labels) is kept. Mutually exclusive with
   * `keysOnly`.
   */
  empty?: boolean;
}

/** `ProjectDestroyResult` plus the liens + `--empty` fields. */
export interface ProjectDestroyResultExt extends ProjectDestroyResult {
  /** Liens found on the project (populated in both dry-run and apply). */
  liens: LienInfo[];
  /** Lien names removed (or that would be removed, in dry-run). */
  liensRemoved: string[];
  /** User-managed service account emails deleted (or planned, in dry-run). `--empty` only. */
  serviceAccountsDeleted: string[];
  /** Whether the `gcp-seeder:<projectId>` budget was (or would be) deleted. `--empty` only. */
  budgetDeleted: boolean;
  /** Non-bootstrap enabled APIs disabled (or planned, in dry-run). `--empty` only. */
  apisDisabled: string[];
}

/** `DestroyResult` plus the `--empty` flag and the extended per-project results. */
export interface DestroyResultExt extends DestroyResult {
  empty: boolean;
  projects: ProjectDestroyResultExt[];
}

/**
 * Tear down explicitly-named projects: revoke their static SA keys and (unless
 * `keysOnly`) soft-delete the project.
 *
 * SAFETY:
 *  - Acts ONLY on the project ids you pass — never discovers/wildcards targets.
 *  - Dry-run by default. Nothing is deleted unless `apply: true`.
 *  - Refuses projects that don't match an orphan pattern unless `force: true`.
 *  - Project deletion is a soft-delete (≈30-day recovery window in GCP).
 *  - DWD grants cannot be removed via any API — they're reported for manual cleanup.
 */
export async function destroyProjects(options: DestroyOptionsExt): Promise<DestroyResultExt> {
  if (!options.projectIds?.length) {
    throw new Error('destroyProjects requires at least one explicit projectId.');
  }
  const keysOnly = options.keysOnly === true;
  const empty = options.empty === true;
  if (keysOnly && empty) {
    throw new Error('destroyProjects: `keysOnly` and `empty` are mutually exclusive.');
  }
  const log = options.logger ?? (() => {});
  const apply = options.apply === true;
  const force = options.force === true;
  const shouldRemoveLiens = options.removeLiens === true;
  const patterns = (options.flagPatterns ?? DEFAULT_FLAG_PATTERNS).map(globToRegex);

  const auth = await resolveAuth(options.auth);
  const iam = google.iam({ version: 'v1', auth: auth as never });
  const crm = google.cloudresourcemanager({ version: 'v1', auth: auth as never });
  const cloudbilling = google.cloudbilling({ version: 'v1', auth: auth as never });
  const billingbudgets = google.billingbudgets({ version: 'v1', auth: auth as never });
  const serviceusage = google.serviceusage({ version: 'v1', auth: auth as never });

  const results: ProjectDestroyResultExt[] = [];

  for (const projectId of options.projectIds) {
    // Ownership check prefers the seeder's own label and falls back to the
    // legacy orphan globs, so label-stamped projects with custom ids (that don't
    // match a glob) are still recognized as safe to target.
    let labels: Record<string, string> | undefined;
    try {
      const { data } = await crm.projects.get({ projectId });
      labels = (data.labels ?? undefined) as Record<string, string> | undefined;
    } catch {
      // No get access / project missing — fall back to glob matching only.
    }
    const matchedPattern = patterns.some((rx) => rx.test(projectId)) || isSeederLabeled(labels);
    const r: ProjectDestroyResultExt = {
      projectId,
      matchedPattern,
      keysDeleted: [],
      serviceAccountsAffected: [],
      wifPoolsDeleted: [],
      projectDeleted: false,
      dwdClientIds: [],
      liens: [],
      liensRemoved: [],
      serviceAccountsDeleted: [],
      budgetDeleted: false,
      apisDisabled: [],
    };

    if (!matchedPattern && !force) {
      r.skipped =
        'not seeder-owned (no seeded-by label) and does not match an orphan pattern; re-run with --force to target it anyway';
      results.push(r);
      log(`SKIP ${projectId} — ${r.skipped}`);
      continue;
    }

    // Gather the SAs and their user-managed keys.
    let accounts: Array<Record<string, unknown>> = [];
    try {
      let token: string | undefined;
      do {
        const { data } = await iam.projects.serviceAccounts.list({
          name: `projects/${projectId}`,
          pageSize: 100,
          pageToken: token,
        });
        accounts = accounts.concat((data.accounts ?? []) as Array<Record<string, unknown>>);
        token = data.nextPageToken ?? undefined;
      } while (token);
    } catch (err) {
      r.skipped = `could not list service accounts: ${(err as Error).message}`;
      results.push(r);
      log(`SKIP ${projectId} — ${r.skipped}`);
      continue;
    }

    for (const sa of accounts) {
      const saName = sa.name as string;
      const saEmail = sa.email as string;
      const clientId = (sa.uniqueId as string) ?? '';
      let keyNames: string[] = [];
      try {
        const { data } = await iam.projects.serviceAccounts.keys.list({
          name: saName,
          keyTypes: ['USER_MANAGED'],
        });
        keyNames = (data.keys ?? []).map((k) => k.name ?? '').filter(Boolean);
      } catch {
        // ignore; nothing to revoke if we can't list
      }
      if (keyNames.length === 0) continue;

      r.serviceAccountsAffected.push(saEmail);
      if (clientId) r.dwdClientIds.push(clientId);

      for (const keyName of keyNames) {
        const keyId = keyName.split('/').pop() ?? keyName;
        if (apply) {
          log(`  deleting key ${keyId} on ${saEmail}…`);
          await iam.projects.serviceAccounts.keys.delete({ name: keyName });
        } else {
          log(`  [dry-run] would delete key ${keyId} on ${saEmail}`);
        }
        r.keysDeleted.push(`${saEmail}:${keyId}`);
      }
    }

    // Tear down keyless-auth (WIF) pools — a standing credential path, so it's
    // revoked in keys-only mode too. Best-effort: if the WIF API is off or
    // access-restricted, there's simply nothing to remove. Pool deletion is a
    // soft-delete (~30-day recovery), consistent with project deletion.
    let pools: Awaited<ReturnType<typeof listWifPools>> = [];
    try {
      pools = await listWifPools(auth, projectId);
    } catch {
      // WIF API off / insufficient permission — nothing to tear down.
    }
    for (const pool of pools) {
      if (apply) {
        log(`  deleting WIF pool ${pool.poolId} (${pool.providers.length} provider(s))…`);
        await deleteWifPool(auth, projectId, pool.poolId);
      } else {
        log(`  [dry-run] would delete WIF pool ${pool.poolId} (${pool.providers.length} provider(s))`);
      }
      r.wifPoolsDeleted.push(pool.poolId);
    }

    // Liens: always listed (informational), regardless of mode — they only
    // matter for the actual `projects.delete` call below, but the plan should
    // surface them either way.
    r.liens = await listLiens(auth, projectId);

    if (empty) {
      // --empty: delete every user-managed SA, the gcp-seeder budget (if any),
      // and disable every non-bootstrap enabled API. Project + labels are kept.
      const userManagedAccounts = accounts.filter((sa) => {
        const email = sa.email as string;
        return email && !isDefaultServiceAccount(email);
      });
      for (const sa of userManagedAccounts) {
        const saName = sa.name as string;
        const saEmail = sa.email as string;
        if (apply) {
          log(`  deleting service account ${saEmail}…`);
          await iam.projects.serviceAccounts.delete({ name: saName });
        } else {
          log(`  [dry-run] would delete service account ${saEmail}`);
        }
        r.serviceAccountsDeleted.push(saEmail);
      }

      // Budget: named `gcp-seeder:<projectId>` on the project's linked billing
      // account, if any. 403 anywhere (no billing.budgets permission, or the
      // caller can't read billing info) is tolerated — log and move on.
      try {
        const { data: billingInfo } = await cloudbilling.projects.getBillingInfo({
          name: `projects/${projectId}`,
        });
        const billingAccountName = billingInfo.billingAccountName ?? undefined;
        if (billingAccountName) {
          const wantedDisplayName = `gcp-seeder:${projectId}`;
          let budgetToDelete: { name?: string | null } | undefined;
          let pageToken: string | undefined;
          do {
            const { data } = await billingbudgets.billingAccounts.budgets.list({
              parent: billingAccountName,
              pageToken,
            });
            budgetToDelete = (data.budgets ?? []).find((b) => b.displayName === wantedDisplayName);
            pageToken = budgetToDelete ? undefined : (data.nextPageToken ?? undefined);
          } while (pageToken);

          if (budgetToDelete?.name) {
            if (apply) {
              log(`  deleting budget ${wantedDisplayName}…`);
              await billingbudgets.billingAccounts.budgets.delete({ name: budgetToDelete.name });
            } else {
              log(`  [dry-run] would delete budget ${wantedDisplayName}`);
            }
            r.budgetDeleted = true;
          }
        }
      } catch (err) {
        log(`  could not check/delete budget on ${projectId}: ${(err as Error).message}`);
      }

      // APIs: every enabled service minus the bootstrap set and sts/iamcredentials.
      try {
        const toDisable: Array<{ name: string; serviceId: string }> = [];
        let pageToken: string | undefined;
        do {
          const { data } = await serviceusage.services.list({
            parent: `projects/${projectId}`,
            filter: 'state:ENABLED',
            pageSize: 200,
            pageToken,
          });
          for (const svc of data.services ?? []) {
            const name = svc.name ?? '';
            const serviceId = name.split('/').pop() ?? '';
            if (!serviceId || EMPTY_MODE_KEEP_APIS.has(serviceId)) continue;
            toDisable.push({ name, serviceId });
          }
          pageToken = data.nextPageToken ?? undefined;
        } while (pageToken);

        for (const { name, serviceId } of toDisable) {
          if (apply) {
            log(`  disabling API ${serviceId}…`);
            const op = await serviceusage.services.disable({
              name,
              requestBody: { disableDependentServices: true },
            });
            await waitForServiceOp(
              async () => (await serviceusage.operations.get({ name: op.data.name! })).data,
              log,
            );
          } else {
            log(`  [dry-run] would disable API ${serviceId}`);
          }
          r.apisDisabled.push(serviceId);
        }
      } catch (err) {
        log(`  could not list/disable APIs on ${projectId}: ${(err as Error).message}`);
      }
    }

    if (!keysOnly && !empty) {
      if (r.liens.length > 0 && !shouldRemoveLiens) {
        r.skipped = `has ${r.liens.length} lien(s); re-run with --remove-liens`;
        log(`SKIP ${projectId} deletion — ${r.skipped}`);
      } else {
        if (r.liens.length > 0) {
          if (apply) {
            r.liensRemoved = await removeProjectLiens(auth, projectId, log);
          } else {
            log(`  [dry-run] would remove ${r.liens.length} lien(s)`);
            r.liensRemoved = r.liens.map((l) => l.name);
          }
        }
        if (apply) {
          log(`  deleting project ${projectId} (soft-delete)…`);
          await crm.projects.delete({ projectId });
          r.projectDeleted = true;
        } else {
          log(`  [dry-run] would soft-delete project ${projectId}`);
        }
      }
    }

    results.push(r);
  }

  return { dryRun: !apply, keysOnly, empty, projects: results };
}
