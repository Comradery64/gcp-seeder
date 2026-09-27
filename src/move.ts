import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { resolveAuth } from './auth.js';
import type { MoveProjectOptions, MoveProjectResult } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MOVE_PERMISSION = 'resourcemanager.projects.move';

/** Validate a destination parent: "organizations/<id>" or "folders/<id>". */
export function parseDestination(destination: string): string {
  if (/^(organizations|folders)\/\d+$/.test(destination)) return destination;
  throw new Error(`Destination "${destination}" must look like "organizations/<id>" or "folders/<id>".`);
}

/** true/false if the caller does/doesn't hold `permission`; null if it couldn't be checked. */
async function hasPermission(
  test: () => Promise<{ data: { permissions?: string[] | null } }>,
  permission: string,
): Promise<boolean | null> {
  try {
    const { data } = await test();
    return (data.permissions ?? []).includes(permission);
  } catch {
    return null;
  }
}

/**
 * Move a project under an organization or folder — e.g. so an org-less project
 * becomes eligible for an Internal OAuth consent screen. Equivalent to
 * `gcloud projects move <id> --organization|--folder <id>`.
 *
 * Dry-run by default (like `destroy`/`rotate`): reports the current and target
 * parent and whether the caller holds `resourcemanager.projects.move` on the
 * project and the destination. Only `apply: true` moves anything. Moving to
 * the parent the project already has is a no-op.
 */
export async function moveProject(options: MoveProjectOptions): Promise<MoveProjectResult> {
  const log = options.logger ?? (() => {});
  const auth: AuthClient = await resolveAuth(options.auth);
  const apply = options.apply === true;
  const { projectId } = options;
  const destination = parseDestination(options.destination);
  const crm = google.cloudresourcemanager({ version: 'v3', auth: auth as never });
  const name = `projects/${projectId}`;

  const { data: project } = await crm.projects.get({ name });
  const from = project.parent || undefined;
  const result: MoveProjectResult = {
    dryRun: !apply,
    projectId,
    from,
    to: destination,
    alreadyThere: from === destination,
    moved: false,
    warnings: [],
  };
  if (result.alreadyThere) {
    log(`✓ ${projectId} is already under ${destination} — nothing to do.`);
    return result;
  }

  const body = { requestBody: { permissions: [MOVE_PERMISSION] } };
  const onProject = await hasPermission(() => crm.projects.testIamPermissions({ resource: name, ...body }), MOVE_PERMISSION);
  const onDestination = await hasPermission(
    () =>
      destination.startsWith('folders/')
        ? crm.folders.testIamPermissions({ resource: destination, ...body })
        : crm.organizations.testIamPermissions({ resource: destination, ...body }),
    MOVE_PERMISSION,
  );
  result.permissions = { onProject, onDestination };
  for (const [where, ok] of [[name, onProject], [destination, onDestination]] as const) {
    if (ok === false) {
      result.warnings.push(
        `Missing ${MOVE_PERMISSION} on ${where}. Grant roles/resourcemanager.projectMover there (scoped to that resource).`,
      );
    }
  }

  if (!apply) {
    log(`[dry-run] would move ${projectId}: ${from ?? '(no parent)'} → ${destination}`);
    for (const w of result.warnings) log(`  ⚠ ${w}`);
    return result;
  }

  log(`Moving ${projectId}: ${from ?? '(no parent)'} → ${destination}…`);
  const op = await crm.projects.move({ name, requestBody: { destinationParent: destination } });
  const start = Date.now();
  for (let done = Boolean(op.data.done); !done; ) {
    if (Date.now() - start > 180_000) throw new Error('Timed out waiting for the project move to complete.');
    await sleep(3_000);
    const { data } = await crm.operations.get({ name: op.data.name! });
    if (data.error) throw new Error(`Project move failed: ${JSON.stringify(data.error)}`);
    done = Boolean(data.done);
  }
  result.moved = true;
  log(`✓ Moved ${projectId} under ${destination}`);
  return result;
}
