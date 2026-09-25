import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';

/**
 * A resource-manager lien. Liens are what makes `PROJECT_DELETE_LIEN` errors
 * happen — Shared VPC host projects, for instance, get one automatically.
 * There is no public API to attach/detach a project *to* Shared VPC via this
 * module; we only surface and (optionally) remove whatever liens already
 * exist so `destroy` can proceed.
 */
export interface LienInfo {
  /** Resource name, e.g. "liens/deadbeef-...". */
  name: string;
  origin?: string;
  reason?: string;
  restrictions: string[];
}

/**
 * List every lien on a project (cloudresourcemanager v3, paginated).
 * A 403 (no `resourcemanager.projects.get`-adjacent lien permission, or the
 * API is off) is not fatal here — callers should note it and move on, so this
 * returns an empty list rather than throwing.
 */
export async function listLiens(auth: AuthClient, projectId: string): Promise<LienInfo[]> {
  const crm = google.cloudresourcemanager({ version: 'v3', auth: auth as never });
  const out: LienInfo[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const { data } = await crm.liens.list({
        parent: `projects/${projectId}`,
        pageToken,
      });
      for (const l of data.liens ?? []) {
        out.push({
          name: l.name ?? '',
          origin: l.origin ?? undefined,
          reason: l.reason ?? undefined,
          restrictions: l.restrictions ?? [],
        });
      }
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch {
    // 403 / API off / no permission — nothing we can report; let the caller note it.
    return [];
  }
  return out;
}

/**
 * Delete every lien on a project. Returns the names of the liens removed.
 * Callers should list first (e.g. via `listLiens`) so they can log what's
 * about to be deleted before calling this.
 */
export async function removeLiens(
  auth: AuthClient,
  projectId: string,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  const crm = google.cloudresourcemanager({ version: 'v3', auth: auth as never });
  const liens = await listLiens(auth, projectId);
  const removed: string[] = [];
  for (const lien of liens) {
    if (!lien.name) continue;
    log(`  removing lien ${lien.name} (${lien.reason ?? 'no reason given'})…`);
    await crm.liens.delete({ name: lien.name });
    removed.push(lien.name);
  }
  return removed;
}
