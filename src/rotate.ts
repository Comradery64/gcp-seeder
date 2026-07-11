import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { resolveAuth } from './auth.js';
import type { RotateOptions, RotateResult } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Same org-policy signal the seeder uses: downloadable keys are forbidden. */
function isKeyCreationBlocked(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /key creation is not allowed|disableServiceAccountKeyCreation/i.test(msg);
}

/** Write a sensitive file with owner-only (0600) permissions. */
async function writeSecret(filePath: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data, { mode: 0o600 });
}

/**
 * Rotate a service account's user-managed key(s): mint a fresh key, write it to
 * disk, then retire the old key(s) in two phases — disable first, then delete —
 * so a bad new key can be caught before the old one is gone for good.
 *
 * Dry-run by default (like `destroy`): reports which keys would be retired and
 * mints nothing. Only `apply: true` mutates.
 *
 * By default every pre-existing user-managed key is retired after the new one
 * is minted; pass `keyId` to retire just one. Google-managed keys are never
 * touched. If key creation is blocked by org policy the old keys are left in
 * place and a warning suggests keyless auth (WIF) instead.
 */
export async function rotateServiceAccountKey(options: RotateOptions): Promise<RotateResult> {
  const log = options.logger ?? (() => {});
  const auth: AuthClient = await resolveAuth(options.auth);
  const apply = options.apply === true;
  const { projectId, serviceAccountEmail } = options;
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'credentials');
  const iam = google.iam({ version: 'v1', auth: auth as never });
  const saName = `projects/${projectId}/serviceAccounts/${serviceAccountEmail}`;

  const result: RotateResult = {
    dryRun: !apply,
    projectId,
    serviceAccountEmail,
    retiredKeyIds: [],
    warnings: [],
  };

  // Which existing user-managed keys are we retiring?
  const { data } = await iam.projects.serviceAccounts.keys.list({ name: saName, keyTypes: ['USER_MANAGED'] });
  const existing = (data.keys ?? []).map((k) => k.name ?? '').filter(Boolean);
  const toRetire = options.keyId
    ? existing.filter((n) => n.split('/').pop() === options.keyId)
    : existing;

  if (options.keyId && toRetire.length === 0) {
    throw new Error(`No user-managed key ${options.keyId} found on ${serviceAccountEmail}.`);
  }

  if (!apply) {
    result.retiredKeyIds = toRetire.map((n) => n.split('/').pop() ?? n);
    log(`[dry-run] would mint a new key for ${serviceAccountEmail} and retire ${result.retiredKeyIds.length} old key(s).`);
    for (const id of result.retiredKeyIds) log(`  [dry-run] would disable then delete ${id}`);
    return result;
  }

  // Phase 1: mint + persist the replacement BEFORE retiring anything.
  log(`Minting a new key for ${serviceAccountEmail}…`);
  let keyData: string | undefined;
  let newKeyId: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const key = await iam.projects.serviceAccounts.keys.create({
        name: saName,
        requestBody: { privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' },
      });
      keyData = key.data.privateKeyData ?? undefined;
      newKeyId = (key.data.name ?? '').split('/').pop() ?? undefined;
      break;
    } catch (err) {
      if (isKeyCreationBlocked(err)) {
        result.warnings.push(
          `Key creation is blocked by an org policy (iam.disableServiceAccountKeyCreation), so nothing ` +
            `was rotated and the existing key(s) were left untouched. For CI, prefer keyless auth: ` +
            `gcp-seeder seed --wif github:owner/repo.`,
        );
        return result;
      }
      if ((err as { code?: number }).code === 404 && attempt < 4) {
        await sleep(3_000);
        continue;
      }
      throw err;
    }
  }
  if (!keyData || !newKeyId) throw new Error('Key rotation aborted: no new key material was returned.');

  const newKeyFile = path.join(outputDir, `${serviceAccountEmail.split('@')[0]}-${newKeyId.slice(0, 8)}.json`);
  await writeSecret(newKeyFile, Buffer.from(keyData, 'base64'));
  result.newKeyId = newKeyId;
  result.newKeyFile = newKeyFile;
  log(`✓ New key ${newKeyId} written to ${newKeyFile}`);

  // Phase 2: retire the old keys — disable first, then delete. Never retire the
  // key we just minted, even if a stale list somehow included it.
  for (const keyName of toRetire) {
    const id = keyName.split('/').pop() ?? keyName;
    if (id === newKeyId) continue;
    log(`  disabling old key ${id}…`);
    await iam.projects.serviceAccounts.keys.disable({ name: keyName });
    log(`  deleting old key ${id}…`);
    await iam.projects.serviceAccounts.keys.delete({ name: keyName });
    result.retiredKeyIds.push(id);
  }

  log(`✓ Rotated ${serviceAccountEmail}: 1 new key, ${result.retiredKeyIds.length} retired.`);
  return result;
}
