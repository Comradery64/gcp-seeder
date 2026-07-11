import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PRESETS, PROVISIONING_PRESETS } from './apis.js';
import { parseWifTarget } from './wif.js';
import type { SeedOptions, ServiceAccountSpec } from './types.js';

/**
 * Schema for a `gcp-seeder.yaml` manifest — a declarative description of the
 * project to reconcile. `.strict()` rejects unknown keys so typos surface
 * instead of silently doing nothing.
 */
const ManifestSchema = z
  .object({
    projectId: z.string().optional(),
    displayName: z.string().optional(),
    parent: z.string().optional(),
    preset: z.string().optional(),
    apis: z.array(z.string()).optional(),
    serviceAccount: z.boolean().optional(),
    serviceAccounts: z
      .array(
        z.object({
          id: z.string(),
          displayName: z.string().optional(),
          keyFile: z.string().optional(),
          dwdScopes: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    wif: z.string().optional(),
    ttl: z.string().optional(),
    oauthClient: z.boolean().optional(),
    supportEmail: z.string().optional(),
    outputDir: z.string().optional(),
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;

/** Parse + validate a manifest YAML file. */
export async function loadManifest(filePath: string): Promise<Manifest> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = ManifestSchema.safeParse(parseYaml(raw) ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid manifest ${filePath}: ${detail}`);
  }
  return parsed.data;
}

/**
 * Map a manifest to `SeedOptions` in reconcile mode. Resolves `preset` the same
 * way the CLI does (simple API presets and provisioning presets that also
 * declare service accounts), and implies a service account when `wif` is set
 * but none was declared — so `seed --manifest` matches `seed --wif`.
 */
export function manifestToSeedOptions(m: Manifest): SeedOptions {
  const provisioning = m.preset ? PROVISIONING_PRESETS[m.preset] : undefined;
  const simplePreset = m.preset && !provisioning ? PRESETS[m.preset] : undefined;
  if (m.preset && !provisioning && !simplePreset) {
    throw new Error(
      `Unknown preset "${m.preset}". Options: ${[...Object.keys(PRESETS), ...Object.keys(PROVISIONING_PRESETS)].join(', ')}`,
    );
  }

  const declaredSas: ServiceAccountSpec[] = (m.serviceAccounts ?? []).map((s) => ({
    id: s.id,
    displayName: s.displayName ?? s.id,
    keyFile: s.keyFile ?? `${s.id}-sa.json`,
    dwdScopes: s.dwdScopes,
  }));
  const serviceAccounts = declaredSas.length ? declaredSas : (provisioning?.serviceAccounts ?? []);
  const apis = [...new Set([...(provisioning?.apis ?? simplePreset ?? []), ...(m.apis ?? [])])];

  // WIF needs an SA to bind; imply one if the manifest didn't declare any.
  const impliedSa = Boolean(m.wif) && serviceAccounts.length === 0;

  return {
    projectId: m.projectId,
    displayName: m.displayName,
    parent: m.parent,
    apis,
    credentials: { serviceAccount: Boolean(m.serviceAccount) || impliedSa, oauthClient: Boolean(m.oauthClient) },
    serviceAccounts: serviceAccounts.length ? serviceAccounts : undefined,
    wif: m.wif ? parseWifTarget(m.wif) : undefined,
    ttl: m.ttl,
    supportEmail: m.supportEmail,
    outputDir: m.outputDir,
    reconcile: true,
  };
}
