import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';

export const ESSENTIAL_CONTACTS_API = 'essentialcontacts.googleapis.com';

/**
 * Record `email` as the project's TECHNICAL essential contact — the real owner
 * address behind the label-safe `owner` label, and who `sweep` will notify.
 *
 * Billed to the project itself (`x-goog-user-project`): Essential Contacts
 * charges the caller's quota project otherwise, which for impersonated or
 * fresh credentials usually doesn't have the API enabled. Idempotent: an
 * existing contact with the same address is left as-is.
 */
export async function ensureOwnerContact(
  auth: AuthClient,
  projectId: string,
  email: string,
  log: (m: string) => void = () => {},
): Promise<{ email: string; existed: boolean }> {
  const ec = google.essentialcontacts({ version: 'v1', auth: auth as never });
  const parent = `projects/${projectId}`;
  const headers = { 'x-goog-user-project': projectId };
  const target = email.trim().toLowerCase();

  const { data } = await ec.projects.contacts.list({ parent, headers } as never);
  if ((data.contacts ?? []).some((c) => c.email?.toLowerCase() === target)) {
    log(`✓ Owner contact ${email} already present`);
    return { email, existed: true };
  }
  await ec.projects.contacts.create({
    parent,
    requestBody: { email, notificationCategorySubscriptions: ['TECHNICAL'], languageTag: 'en' },
    headers,
  } as never);
  log(`✓ Owner contact set: ${email} (Essential Contacts, TECHNICAL)`);
  return { email, existed: false };
}
