import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A project IAM policy as returned by Cloud Resource Manager (v3). */
export interface IamPolicy {
  bindings?: Array<{ role: string; members: string[]; condition?: unknown }>;
  etag?: string | null;
  version?: number | null;
}

/**
 * Read-modify-write a project's IAM policy safely.
 *
 * Every mutation to a project policy MUST go through this helper: it fetches
 * the current policy with its etag, applies `mutate`, and writes it back with
 * that etag so a concurrent edit can never be silently clobbered. On an etag
 * conflict (409 / ABORTED) it re-reads and retries. If `mutate` returns
 * `null` the policy is left untouched (no write at all) — use that to make
 * callers idempotent.
 *
 * Callers must only add or remove specific bindings; never replace the whole
 * bindings array with a smaller one unless that is explicitly the intent.
 */
export async function modifyProjectIamPolicy(
  auth: AuthClient,
  projectId: string,
  mutate: (policy: IamPolicy) => IamPolicy | null,
  { attempts = 5, intervalMs = 2_000 } = {},
): Promise<{ changed: boolean; policy: IamPolicy }> {
  const crm = google.cloudresourcemanager({ version: 'v3', auth: auth as never });
  const resource = `projects/${projectId}`;
  for (let attempt = 1; ; attempt++) {
    const { data } = await crm.projects.getIamPolicy({
      resource,
      requestBody: { options: { requestedPolicyVersion: 3 } },
    });
    const current: IamPolicy = {
      bindings: (data.bindings ?? []).map((b) => ({
        role: b.role!,
        members: [...(b.members ?? [])],
        ...(b.condition ? { condition: b.condition } : {}),
      })),
      etag: data.etag,
      version: data.version ?? 3,
    };
    const next = mutate(structuredClone(current));
    if (next === null) return { changed: false, policy: current };
    try {
      const { data: written } = await crm.projects.setIamPolicy({
        resource,
        requestBody: { policy: { ...next, etag: current.etag, version: 3 } as never },
      });
      return { changed: true, policy: written as IamPolicy };
    } catch (err) {
      if (!isEtagConflict(err) || attempt >= attempts) throw err;
      await sleep(intervalMs);
    }
  }
}

/** True when setIamPolicy was rejected because the policy changed underneath us. */
function isEtagConflict(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 409 || /ABORTED|etag|concurrent policy changes/i.test(msg);
}

/**
 * Ensure `member` holds each of `roles` on the project. Idempotent: roles
 * already bound are skipped, and no write happens if nothing is missing.
 * Returns the roles that were actually added.
 */
export async function ensureProjectRoles(
  auth: AuthClient,
  projectId: string,
  member: string,
  roles: string[],
): Promise<string[]> {
  const added: string[] = [];
  await modifyProjectIamPolicy(auth, projectId, (policy) => {
    policy.bindings ??= [];
    for (const role of roles) {
      // Only unconditional bindings count — a conditional grant is a different thing.
      const binding = policy.bindings.find((b) => b.role === role && !b.condition);
      if (binding?.members.includes(member)) continue;
      if (binding) binding.members.push(member);
      else policy.bindings.push({ role, members: [member] });
      added.push(role);
    }
    return added.length ? policy : null;
  });
  return added;
}

/**
 * Remove `member` from `role` on the project (unconditional binding only).
 * Idempotent: returns false and writes nothing if the member wasn't bound.
 */
export async function removeProjectRole(
  auth: AuthClient,
  projectId: string,
  member: string,
  role: string,
): Promise<boolean> {
  const { changed } = await modifyProjectIamPolicy(auth, projectId, (policy) => {
    const binding = policy.bindings?.find((b) => b.role === role && !b.condition);
    if (!binding || !binding.members.includes(member)) return null;
    binding.members = binding.members.filter((m) => m !== member);
    if (binding.members.length === 0) policy.bindings = policy.bindings!.filter((b) => b !== binding);
    return policy;
  });
  return changed;
}
