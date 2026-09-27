import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ProbeStatus = 'ready' | 'timeout' | 'skipped';

export interface ProbeResult {
  api: string;
  status: ProbeStatus;
}

/**
 * True for the "API has not been used in project … or it is disabled …
 * wait a few minutes" 403 that Google returns right after `services.enable`
 * reports success but the service isn't usable yet. Distinct from a real
 * permissions problem, which persists across retries and doesn't carry this
 * exact phrasing.
 */
export function isApiNotReadyError(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 403 && /has not been used in project/i.test(msg) && /or it is disabled/i.test(msg);
}

/** Poll serviceusage `services.get` until every api is `state === 'ENABLED'`. */
export async function waitForServicesEnabled(
  auth: AuthClient,
  projectId: string,
  apis: string[],
  opts?: { timeoutMs?: number; intervalMs?: number; log?: (m: string) => void },
): Promise<void> {
  const { timeoutMs = 120_000, intervalMs = 5_000, log = () => {} } = opts ?? {};
  const su = google.serviceusage({ version: 'v1', auth: auth as never });
  const remaining = new Set(apis);
  const start = Date.now();
  for (;;) {
    for (const api of [...remaining]) {
      const { data } = await su.services.get({ name: `projects/${projectId}/services/${api}` });
      if (data.state === 'ENABLED') remaining.delete(api);
    }
    if (remaining.size === 0) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for API(s) to report ENABLED: ${[...remaining].join(', ')}`,
      );
    }
    log(`  still waiting for API(s) to report ENABLED: ${[...remaining].join(', ')}`);
    await sleep(intervalMs);
  }
}

type ProbeFn = (auth: AuthClient, projectId: string) => Promise<unknown>;

/**
 * Cheap, side-effect-free read per API used to actively confirm the service
 * is usable (not just "enabled"). Only APIs in this table are probed; others
 * are reported 'skipped'.
 *
 * Deviations from the plan's exact call shape (see report.md for detail):
 * every listed client/method exists in the installed googleapis version
 * (144.x); the only change is `firestore.projects.databases.list`, which
 * (unlike the other list calls) has no `pageSize` param in its typed request
 * — called with just `parent`.
 */
function buildProbes(): Record<string, ProbeFn> {
  return {
    'iam.googleapis.com': (auth, projectId) =>
      google.iam({ version: 'v1', auth: auth as never }).projects.serviceAccounts.list({
        name: `projects/${projectId}`,
        pageSize: 1,
      }),
    'cloudresourcemanager.googleapis.com': (auth, projectId) =>
      google.cloudresourcemanager({ version: 'v3', auth: auth as never }).projects.get({
        name: `projects/${projectId}`,
      }),
    'serviceusage.googleapis.com': (auth, projectId) =>
      google.serviceusage({ version: 'v1', auth: auth as never }).services.list({
        parent: `projects/${projectId}`,
        pageSize: 1,
      }),
    'aiplatform.googleapis.com': (auth, projectId) =>
      google.aiplatform({ version: 'v1', auth: auth as never }).projects.locations.list({
        name: `projects/${projectId}`,
        pageSize: 1,
      }),
    'run.googleapis.com': (auth, projectId) =>
      google.run({ version: 'v2', auth: auth as never }).projects.locations.services.list({
        parent: `projects/${projectId}/locations/us-central1`,
        pageSize: 1,
      }),
    'storage.googleapis.com': (auth, projectId) =>
      google.storage({ version: 'v1', auth: auth as never }).buckets.list({
        project: projectId,
        maxResults: 1,
      }),
    'bigquery.googleapis.com': (auth, projectId) =>
      google.bigquery({ version: 'v2', auth: auth as never }).datasets.list({
        projectId,
        maxResults: 1,
      }),
    'pubsub.googleapis.com': (auth, projectId) =>
      google.pubsub({ version: 'v1', auth: auth as never }).projects.topics.list({
        project: `projects/${projectId}`,
        pageSize: 1,
      }),
    'cloudfunctions.googleapis.com': (auth, projectId) =>
      google.cloudfunctions({ version: 'v2', auth: auth as never }).projects.locations.functions.list({
        parent: `projects/${projectId}/locations/us-central1`,
        pageSize: 1,
      }),
    'firestore.googleapis.com': (auth, projectId) =>
      google.firestore({ version: 'v1', auth: auth as never }).projects.databases.list({
        parent: `projects/${projectId}`,
      }),
  };
}

/**
 * Actively probe known APIs with a cheap read and retry while
 * `isApiNotReadyError`. Unknown APIs are skipped (not an error). Never
 * throws on timeout — a persistently-not-ready API is reported with status
 * 'timeout' so the caller can decide what to do.
 */
export async function probeApisReady(
  auth: AuthClient,
  projectId: string,
  apis: string[],
  opts?: { timeoutMs?: number; intervalMs?: number; log?: (m: string) => void },
): Promise<ProbeResult[]> {
  const { timeoutMs = 120_000, intervalMs = 5_000, log = () => {} } = opts ?? {};
  const probes = buildProbes();
  const results: ProbeResult[] = [];
  for (const api of apis) {
    const probe = probes[api];
    if (!probe) {
      results.push({ api, status: 'skipped' });
      continue;
    }
    const start = Date.now();
    let status: ProbeStatus = 'ready';
    for (;;) {
      try {
        await probe(auth, projectId);
        status = 'ready';
        break;
      } catch (err) {
        // A 403/other error that is NOT the "not ready" shape still counts as
        // ready: the credentials/permissions boundary is separate from
        // whether the API itself has finished propagating.
        if (!isApiNotReadyError(err)) {
          status = 'ready';
          break;
        }
        if (Date.now() - start > timeoutMs) {
          status = 'timeout';
          break;
        }
        log(`  ${api} not ready yet — retrying…`);
        await sleep(intervalMs);
      }
    }
    results.push({ api, status });
  }
  return results;
}

/** Retry `fn` while `isApiNotReadyError`. Reusable by seeder/wif for the first calls after `enableApis`. */
export async function withApiReadyRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; intervalMs?: number; log?: (m: string) => void },
): Promise<T> {
  const { attempts = 10, intervalMs = 5_000, log = () => {} } = opts ?? {};
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isApiNotReadyError(err) || attempt >= attempts) throw err;
      log('  API not yet ready — retrying…');
      await sleep(intervalMs);
    }
  }
}
