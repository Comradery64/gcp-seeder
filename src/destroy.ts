import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { resolveAuth } from './auth.js';
import type { DestroyOptions, DestroyResult, ProjectDestroyResult } from './types.js';

const DEFAULT_FLAG_PATTERNS = ['gyb-project-*', 'seed-*'];

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
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
export async function destroyProjects(options: DestroyOptions): Promise<DestroyResult> {
  if (!options.projectIds?.length) {
    throw new Error('destroyProjects requires at least one explicit projectId.');
  }
  const log = options.logger ?? (() => {});
  const apply = options.apply === true;
  const keysOnly = options.keysOnly === true;
  const force = options.force === true;
  const patterns = (options.flagPatterns ?? DEFAULT_FLAG_PATTERNS).map(globToRegex);

  const auth = await resolveAuth(options.auth);
  const iam = google.iam({ version: 'v1', auth: auth as never });
  const crm = google.cloudresourcemanager({ version: 'v1', auth: auth as never });

  const results: ProjectDestroyResult[] = [];

  for (const projectId of options.projectIds) {
    const matchedPattern = patterns.some((rx) => rx.test(projectId));
    const r: ProjectDestroyResult = {
      projectId,
      matchedPattern,
      keysDeleted: [],
      serviceAccountsAffected: [],
      projectDeleted: false,
      dwdClientIds: [],
    };

    if (!matchedPattern && !force) {
      r.skipped = 'does not match an orphan pattern; re-run with --force to target it anyway';
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

    if (!keysOnly) {
      if (apply) {
        log(`  deleting project ${projectId} (soft-delete)…`);
        await crm.projects.delete({ projectId });
        r.projectDeleted = true;
      } else {
        log(`  [dry-run] would soft-delete project ${projectId}`);
      }
    }

    results.push(r);
  }

  return { dryRun: !apply, keysOnly, projects: results };
}
