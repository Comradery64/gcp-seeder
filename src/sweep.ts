import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { resolveAuth } from './auth.js';
import { destroyProjects } from './destroy.js';
import { ageInDays, isExpired, isSeederLabeled, parseDuration } from './labels.js';
import type { SweepCandidate, SweepOptions, SweepResult } from './types.js';

const DEFAULT_FLAG_PATTERNS = ['gyb-project-*', 'seed-*'];

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

interface RawProject {
  projectId?: string;
  lifecycleState?: string;
  labels?: Record<string, string>;
}

async function listProjects(auth: AuthClient): Promise<RawProject[]> {
  const crm = google.cloudresourcemanager({ version: 'v1', auth: auth as never });
  const out: RawProject[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await crm.projects.list({ pageSize: 200, pageToken });
    for (const p of data.projects ?? []) out.push(p as RawProject);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Find seeder-owned projects and delete the expired (and, with `--max-age`,
 * stale) ones. Ownership is claimed by the `seeded-by` label first, falling
 * back to the legacy orphan globs so pre-label projects are still catchable.
 *
 * Deletion is delegated to `destroyProjects`, so all of destroy's safety rails
 * apply: dry-run by default, soft-delete (~30-day recovery), and the same
 * ownership check. Only ACTIVE projects are considered (already-deleting ones
 * are skipped).
 */
export async function sweepProjects(options: SweepOptions = {}): Promise<SweepResult> {
  const log = options.logger ?? (() => {});
  const auth = await resolveAuth(options.auth);
  const now = options.now ?? new Date();
  const patterns = (options.flagPatterns ?? DEFAULT_FLAG_PATTERNS).map(globToRegex);
  const maxAgeDays = options.maxAge ? parseDuration(options.maxAge) / 86_400_000 : undefined;

  log('Listing projects…');
  const projects = await listProjects(auth);

  const candidates: SweepCandidate[] = [];
  for (const p of projects) {
    const projectId = p.projectId;
    if (!projectId) continue;
    if (p.lifecycleState && p.lifecycleState !== 'ACTIVE') continue; // skip already-deleting

    const byLabel = isSeederLabeled(p.labels);
    const byGlob = patterns.some((rx) => rx.test(projectId));
    if (!byLabel && !byGlob) continue; // not ours — leave it alone

    const expired = isExpired(p.labels, now);
    const age = ageInDays(p.labels, now);
    const stale = maxAgeDays !== undefined && age !== undefined && age >= maxAgeDays;

    candidates.push({
      projectId,
      ownedBy: byLabel ? 'label' : 'glob',
      seededAt: p.labels?.['seeded-at'],
      expires: p.labels?.expires,
      ageDays: age,
      expired,
      stale,
      selected: expired || stale,
    });
  }

  log(`Found ${candidates.length} seeder-owned project(s); ${candidates.filter((c) => c.selected).length} to sweep.`);

  const selectedIds = candidates.filter((c) => c.selected).map((c) => c.projectId);
  let destroy: SweepResult['destroy'];
  if (selectedIds.length) {
    destroy = await destroyProjects({
      projectIds: selectedIds,
      apply: options.apply,
      flagPatterns: options.flagPatterns,
      auth,
      logger: options.logger,
    });
  }

  return { dryRun: options.apply !== true, scanned: candidates.length, candidates, destroy };
}
