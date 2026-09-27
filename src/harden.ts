import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { removeProjectRole } from './iam.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

export interface HardenOptions {
  /** Delete the auto-created "default" VPC and its firewall rules. Default true. */
  deleteDefaultNetwork?: boolean;
  /** Remove roles/editor from the default compute service account. Default true. */
  demoteDefaultComputeSa?: boolean;
}

export interface HardenResult {
  defaultNetworkDeleted: boolean;
  firewallRulesDeleted: string[];
  defaultComputeSaEditorRemoved: boolean;
  skipped: string[];
}

type ComputeOp = { name?: string | null; status?: string | null; error?: unknown };

function isNotFound(err: unknown): boolean {
  return (err as { code?: number }).code === 404;
}

/** compute.googleapis.com was just enabled and isn't usable yet (local copy — do not import feature C). */
function isApiNotReady(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 403 && /has not been used in project|or it is disabled/i.test(msg);
}

async function withComputeReadyRetry<T>(
  fn: () => Promise<T>,
  log: (m: string) => void,
  { attempts = 8, intervalMs = 8_000 } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isApiNotReady(err) || attempt >= attempts) throw err;
      log('  compute.googleapis.com not ready yet — retrying…');
      await sleep(intervalMs);
    }
  }
}

async function waitForComputeOperation(
  getOp: () => Promise<ComputeOp>,
  initial: ComputeOp,
  log: (m: string) => void,
  { timeoutMs = 300_000, intervalMs = 3_000 } = {},
): Promise<void> {
  const start = Date.now();
  let op = initial;
  for (;;) {
    if (op.status === 'DONE') {
      if (op.error) throw new Error(`Compute operation ${op.name ?? ''} failed: ${JSON.stringify(op.error)}`);
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for compute operation ${op.name ?? ''} to complete.`);
    }
    await sleep(intervalMs);
    op = await getOp();
    if (op.status !== 'DONE') log('  …still working');
  }
}

/**
 * Remove the insecure defaults every new project gets. Requires
 * compute.googleapis.com enabled. Idempotent: a missing network / missing
 * binding is recorded in `skipped`, not an error.
 */
export async function hardenProjectDefaults(
  auth: AuthClient,
  projectId: string,
  projectNumber: string,
  opts: HardenOptions = {},
  log: (m: string) => void = noop,
): Promise<HardenResult> {
  const { deleteDefaultNetwork = true, demoteDefaultComputeSa = true } = opts;
  const result: HardenResult = {
    defaultNetworkDeleted: false,
    firewallRulesDeleted: [],
    defaultComputeSaEditorRemoved: false,
    skipped: [],
  };

  if (deleteDefaultNetwork) {
    const compute = google.compute({ version: 'v1', auth: auth as never });
    const wait = (op: ComputeOp) =>
      waitForComputeOperation(
        async () => (await compute.globalOperations.get({ project: projectId, operation: op.name! })).data,
        op,
        log,
      );

    const rules: Array<{ name?: string | null; network?: string | null }> = [];
    let pageToken: string | undefined;
    do {
      const { data } = await withComputeReadyRetry(
        () => compute.firewalls.list({ project: projectId, pageToken }),
        log,
      );
      rules.push(...(data.items ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);

    for (const rule of rules) {
      if (!rule.name || !rule.network?.endsWith('/global/networks/default')) continue;
      try {
        const { data: op } = await compute.firewalls.delete({ project: projectId, firewall: rule.name });
        await wait(op);
        result.firewallRulesDeleted.push(rule.name);
        log(`  deleted firewall rule ${rule.name}`);
      } catch (err) {
        if (!isNotFound(err)) throw err;
        result.skipped.push(`firewall rule ${rule.name}: already gone`);
      }
    }

    try {
      const { data: op } = await compute.networks.delete({ project: projectId, network: 'default' });
      await wait(op);
      result.defaultNetworkDeleted = true;
      log('✓ Default network deleted');
    } catch (err) {
      if (!isNotFound(err)) throw err;
      result.skipped.push('default network: not found (already deleted)');
    }
  } else {
    result.skipped.push('default network: disabled by option');
  }

  if (demoteDefaultComputeSa) {
    // Demote only. NEVER delete or disable the default compute SA: a deleted
    // default SA is unrecoverable after 30 days, and Compute/GKE/Cloud Build
    // break in ways that can't be fixed without recreating the project.
    const member = `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`;
    result.defaultComputeSaEditorRemoved = await removeProjectRole(auth, projectId, member, 'roles/editor');
    if (result.defaultComputeSaEditorRemoved) log('✓ Removed roles/editor from the default compute service account');
    else result.skipped.push('default compute SA: roles/editor not bound');
  } else {
    result.skipped.push('default compute SA: disabled by option');
  }

  return result;
}
