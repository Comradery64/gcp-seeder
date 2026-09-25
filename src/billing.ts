import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';

const noop = (_m: string): void => {};

/** A billing account visible to the caller. */
export interface BillingAccountInfo {
  name: string;
  displayName: string;
  open: boolean;
}

/** Strip an optional `billingAccounts/` prefix so ids compare uniformly. */
function bareId(id: string): string {
  return id.startsWith('billingAccounts/') ? id.slice('billingAccounts/'.length) : id;
}

/** Normalize a user-supplied id to the `billingAccounts/<id>` resource name. */
function fullName(id: string): string {
  return id.startsWith('billingAccounts/') ? id : `billingAccounts/${id}`;
}

/** All billing accounts the caller can see (cloudbilling v1 billingAccounts.list, paginated). */
export async function listBillingAccounts(auth: AuthClient): Promise<BillingAccountInfo[]> {
  const cb = google.cloudbilling({ version: 'v1', auth: auth as never });
  const out: BillingAccountInfo[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await cb.billingAccounts.list({ pageToken });
    for (const a of data.billingAccounts ?? []) {
      if (!a.name) continue;
      out.push({ name: a.name, displayName: a.displayName ?? a.name, open: a.open ?? false });
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Decide which billing account to use. `requested` may be given with or
 * without the `billingAccounts/` prefix; it is normalized and verified
 * against the caller's accounts (throwing a clear error if unknown or
 * closed). With no `requested`: exactly one open account is auto-picked;
 * zero open accounts return no candidates; several return the candidates
 * for the caller (e.g. a CLI prompt) to choose from.
 */
export async function resolveBillingAccount(
  auth: AuthClient,
  requested?: string,
): Promise<{ account?: string; candidates: BillingAccountInfo[] }> {
  const accounts = await listBillingAccounts(auth);

  if (requested) {
    const target = fullName(requested);
    const match = accounts.find((a) => a.name === target);
    if (!match) {
      throw new Error(`Billing account ${bareId(requested)} was not found among the accounts you can access.`);
    }
    if (!match.open) {
      throw new Error(`Billing account ${bareId(requested)} is closed and cannot be linked to a project.`);
    }
    return { account: match.name, candidates: [] };
  }

  const open = accounts.filter((a) => a.open);
  if (open.length === 1) return { account: open[0]!.name, candidates: [] };
  if (open.length === 0) return { account: undefined, candidates: [] };
  return { account: undefined, candidates: open };
}

/** True when the current 403 is a billing-account-level permission error. */
function isBillingPermissionDenied(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  return code === 403;
}

/** True when the error is the projects-per-billing-account quota precondition. */
function isPreconditionFailed(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  const status = (err as { status?: string; errors?: Array<{ reason?: string }> }).status;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 400 || status === 'FAILED_PRECONDITION' || /Precondition check failed/i.test(msg);
}

/**
 * Link `projectId` to `billingAccount` (projects.updateBillingInfo).
 * Idempotent: if the project is already linked to this account, logs and
 * returns without calling the API again.
 */
export async function linkBillingAccount(
  auth: AuthClient,
  projectId: string,
  billingAccount: string,
  log: (m: string) => void = noop,
): Promise<void> {
  const target = fullName(billingAccount);
  const id = bareId(billingAccount);
  const current = await getLinkedBillingAccount(auth, projectId);
  if (current === target) {
    log(`Project ${projectId} is already linked to billing account ${id}.`);
    return;
  }

  const cb = google.cloudbilling({ version: 'v1', auth: auth as never });
  try {
    await cb.projects.updateBillingInfo({
      name: `projects/${projectId}`,
      requestBody: { billingAccountName: target },
    });
    log(`Linked project ${projectId} to billing account ${id}.`);
  } catch (err) {
    if (isPreconditionFailed(err)) {
      throw new Error(
        `Billing account ${id} has hit its projects-per-billing-account quota (default 5). Unlink a project or request an increase: https://console.cloud.google.com/billing/${id}/manage`,
      );
    }
    if (isBillingPermissionDenied(err)) {
      throw new Error(
        `Cannot link billing account ${id}: you need roles/billing.user ON THE BILLING ACCOUNT itself (an org-level grant is not enough when the account lives outside the org).`,
      );
    }
    throw err;
  }
}

/** projects.getBillingInfo → the linked billingAccountName, or undefined when unlinked. */
export async function getLinkedBillingAccount(auth: AuthClient, projectId: string): Promise<string | undefined> {
  const cb = google.cloudbilling({ version: 'v1', auth: auth as never });
  const { data } = await cb.projects.getBillingInfo({ name: `projects/${projectId}` });
  if (!data.billingEnabled || !data.billingAccountName) return undefined;
  return data.billingAccountName;
}

/** billingAccounts.testIamPermissions for `billing.resourceAssociations.create`. Used by preflight. */
export async function canLinkProjects(auth: AuthClient, billingAccount: string): Promise<boolean> {
  const cb = google.cloudbilling({ version: 'v1', auth: auth as never });
  const { data } = await cb.billingAccounts.testIamPermissions({
    resource: fullName(billingAccount),
    requestBody: { permissions: ['billing.resourceAssociations.create'] },
  });
  return (data.permissions ?? []).includes('billing.resourceAssociations.create');
}
