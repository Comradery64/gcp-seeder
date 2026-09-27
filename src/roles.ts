import type { AuthClient } from 'google-auth-library';
import { ensureProjectRoles } from './iam.js';

/** Default roles per preset. Keep minimal; Workspace/DWD presets get none (DWD, not IAM). */
export const PRESET_ROLES: Record<string, string[]> = {
  ai: ['roles/aiplatform.user'], // Vertex AI (incl. Gemini on Vertex) calls
  gmail: [],
  workspace: [],
  'directory-sync': [],
};

const PREDEFINED_ROLE = /^roles\/[A-Za-z0-9_.]+$/;
const CUSTOM_ROLE = /^(projects|organizations)\/[^/]+\/roles\/[A-Za-z0-9_.]+$/;
const BASIC_ROLES = new Set(['roles/owner', 'roles/editor', 'roles/viewer']);

/**
 * Validate role names and dedupe them (first occurrence wins, order kept).
 * Accepts predefined (`roles/...`) and custom (`projects|organizations/<id>/roles/...`)
 * roles. Basic roles (owner/editor/viewer) are rejected unless `allowBasic`.
 * Throws one Error listing every invalid entry.
 */
export function validateRoles(roles: string[], { allowBasic = false } = {}): string[] {
  const out: string[] = [];
  const problems: string[] = [];
  for (const raw of roles) {
    const role = raw.trim();
    if (!PREDEFINED_ROLE.test(role) && !CUSTOM_ROLE.test(role)) {
      problems.push(`"${raw}" (expected roles/<name> or projects|organizations/<id>/roles/<name>)`);
      continue;
    }
    if (BASIC_ROLES.has(role) && !allowBasic) {
      problems.push(`"${role}" (basic role is too broad; grant a specific role, or opt in to basic roles explicitly)`);
      continue;
    }
    if (!out.includes(role)) out.push(role);
  }
  if (problems.length) throw new Error(`Invalid IAM role(s): ${problems.join('; ')}`);
  return out;
}

/**
 * Grant `roles` on the project to the service account via ensureProjectRoles.
 * Idempotent; returns the roles actually added.
 */
export async function grantServiceAccountRoles(
  auth: AuthClient,
  projectId: string,
  saEmail: string,
  roles: string[],
  log: (m: string) => void = () => {},
): Promise<string[]> {
  if (roles.length === 0) return [];
  const member = `serviceAccount:${saEmail}`;
  let added: string[];
  try {
    added = await ensureProjectRoles(auth, projectId, member, roles);
  } catch (err) {
    throw mapInvalidRoleError(err, roles, projectId) ?? err;
  }
  for (const role of added) log(`granted ${role} to ${member} on ${projectId}`);
  return added;
}

function mapInvalidRoleError(err: unknown, roles: string[], projectId: string): Error | null {
  const e = err as { code?: number | string; message?: string } | undefined;
  const msg = err instanceof Error ? err.message : String(e?.message ?? err);
  const invalidArg = e?.code === 400 || /INVALID_ARGUMENT/.test(msg);
  if (!invalidArg || !/is not supported|does not exist/i.test(msg)) return null;
  const named = msg.match(/Role \(?([^\s)]+?)\)? (?:is not supported|does not exist)/i)?.[1];
  const role = roles.find((r) => r === named) ?? roles.find((r) => msg.includes(r)) ?? named;
  if (!role) return null;
  return new Error(
    `IAM role "${role}" was rejected for project ${projectId} (it does not exist or is not supported on projects): ${msg}`,
  );
}
