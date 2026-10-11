import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseDuration } from './labels.js';

/**
 * Org-wide policy for `gcp-seeder.org.yaml`. An admin writes it once; every
 * seed is checked against it. Semantics are narrow-only: a request may tighten
 * a rule (shorter ttl, smaller budget) but never loosen it. Absent sections
 * impose no rule. `.strict()` rejects unknown keys so typos surface.
 */
const ParentRef = z.string().regex(/^(organizations|folders)\/\d+$/, 'must look like folders/<id> or organizations/<id>');
const Duration = z.string().refine((v) => {
  try {
    parseDuration(v);
    return true;
  } catch {
    return false;
  }
}, 'must be a duration like 30d, 2w or 12h');

export const OrgConfigSchema = z
  .object({
    version: z.literal(1),
    parents: z
      .object({ default: ParentRef.optional(), allowed: z.array(ParentRef).min(1).optional() })
      .strict()
      .refine((p) => !p.default || !p.allowed || p.allowed.includes(p.default), 'parents.default must be in parents.allowed')
      .optional(),
    billing: z.object({ account: z.string().optional(), required: z.boolean().optional() }).strict().optional(),
    budget: z
      .object({ defaultUsd: z.number().positive().optional(), maxUsd: z.number().positive().optional() })
      .strict()
      .refine((b) => !b.defaultUsd || !b.maxUsd || b.defaultUsd <= b.maxUsd, 'budget.defaultUsd must not exceed budget.maxUsd')
      .optional(),
    ttl: z
      .object({ default: Duration.optional(), max: Duration.optional(), allowNone: z.boolean().optional() })
      .strict()
      .refine((t) => !t.default || !t.max || parseDuration(t.default) <= parseDuration(t.max), 'ttl.default must not exceed ttl.max')
      .optional(),
    labels: z.object({ required: z.array(z.string()).optional() }).strict().optional(),
    owner: z.object({ required: z.boolean().optional() }).strict().optional(),
    harden: z.boolean().optional(),
    keys: z.enum(['allow', 'forbid']).optional(),
    apis: z.object({ denied: z.array(z.string()).optional() }).strict().optional(),
  })
  .strict();

export type OrgConfig = z.infer<typeof OrgConfigSchema>;

/** Parse + validate an org config YAML file. */
export async function loadOrgConfig(filePath: string): Promise<OrgConfig> {
  const raw = await readFile(filePath, 'utf8');
  return parseOrgConfig(parseYaml(raw) ?? {}, filePath);
}

export function parseOrgConfig(data: unknown, source = 'org config'): OrgConfig {
  const parsed = OrgConfigSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid ${source}: ${detail}`);
  }
  return parsed.data;
}

/**
 * Encode an email as a GCP label value (`[a-z0-9_-]`, ≤63 chars). One-way by
 * design — `@` becomes `_at_`, any other disallowed char becomes `-`, and
 * over-long values are truncated with a short hash so they stay unique. The
 * real address lives in Essential Contacts; never parse it back out of this.
 */
export function encodeOwnerLabel(email: string): string {
  const normalized = email.trim().toLowerCase();
  const encoded = normalized.replace('@', '_at_').replace(/[^a-z0-9_-]/g, '-');
  if (encoded.length <= 63) return encoded;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${encoded.slice(0, 54)}-${hash}`;
}

/** The subset of a seed request that org policy governs. */
export interface PolicyRequest {
  parent?: string;
  billingAccount?: string;
  budgetUsd?: number;
  ttl?: string;
  harden?: boolean;
  wantsServiceAccountKey?: boolean;
  apis?: string[];
  labels?: Record<string, string>;
  owner?: string;
}

export interface PolicyViolation {
  rule: string;
  detail: string;
  fix: string;
}

/**
 * Apply org policy to a request: fill unset values from the config's defaults
 * and report every rule the request breaks. Never throws — callers decide
 * (preflight reports, seed refuses when `violations` is non-empty).
 */
export function applyOrgPolicy(config: OrgConfig, req: PolicyRequest): { resolved: PolicyRequest; violations: PolicyViolation[] } {
  const resolved: PolicyRequest = { ...req, labels: { ...(req.labels ?? {}) } };
  const violations: PolicyViolation[] = [];
  const v = (rule: string, detail: string, fix: string) => violations.push({ rule, detail, fix });

  // parents
  resolved.parent ??= config.parents?.default;
  const allowed = config.parents?.allowed;
  if (allowed && (!resolved.parent || !allowed.includes(resolved.parent))) {
    v('parents.allowed', `Parent ${resolved.parent ?? '(none)'} is not allowed.`, `Use --parent with one of: ${allowed.join(', ')}.`);
  }

  // billing
  resolved.billingAccount ??= config.billing?.account;
  if (config.billing?.required && !resolved.billingAccount) {
    v('billing.required', 'Org policy requires a linked billing account.', 'Pass --billing-account <id>.');
  }

  // budget
  if (resolved.budgetUsd === undefined && config.budget?.defaultUsd !== undefined && resolved.billingAccount) {
    resolved.budgetUsd = config.budget.defaultUsd;
  }
  const maxUsd = config.budget?.maxUsd;
  if (maxUsd !== undefined && resolved.budgetUsd !== undefined && resolved.budgetUsd > maxUsd) {
    v('budget.maxUsd', `Budget $${resolved.budgetUsd} exceeds the org maximum of $${maxUsd}.`, `Use --budget ${maxUsd} or less.`);
  }

  // ttl
  resolved.ttl ??= config.ttl?.default;
  if (resolved.ttl) {
    const maxTtl = config.ttl?.max;
    if (maxTtl && parseDuration(resolved.ttl) > parseDuration(maxTtl)) {
      v('ttl.max', `TTL ${resolved.ttl} exceeds the org maximum of ${maxTtl}.`, `Use --ttl ${maxTtl} or shorter.`);
    }
  } else if (config.ttl?.allowNone === false) {
    v('ttl.allowNone', 'Org policy requires every project to expire.', `Pass --ttl (max ${config.ttl.max ?? 'unbounded'}).`);
  }

  // harden
  if (config.harden === true) {
    if (resolved.harden === false) {
      v('harden', 'Org policy requires hardened project defaults.', 'Drop --no-harden.');
    }
    resolved.harden = true;
  }

  // keys
  if (config.keys === 'forbid' && resolved.wantsServiceAccountKey) {
    v('keys', 'Org policy forbids downloadable service account keys.', 'Use keyless auth instead: --wif github:owner/repo or gitlab:group/project.');
  }

  // apis
  const denied = new Set(config.apis?.denied ?? []);
  const hits = (resolved.apis ?? []).filter((a) => denied.has(a));
  if (hits.length) {
    v('apis.denied', `These APIs are denied by org policy: ${hits.join(', ')}.`, 'Remove them from --apis / the preset.');
  }

  // owner + labels
  if (resolved.owner) resolved.labels!.owner = encodeOwnerLabel(resolved.owner);
  else if (config.owner?.required) {
    v('owner.required', 'Org policy requires an owner.', 'Pass --owner <email>.');
  }
  const ownerFlagged = violations.some((x) => x.rule === 'owner.required');
  const missing = (config.labels?.required ?? []).filter((k) => !resolved.labels![k] && !(k === 'owner' && ownerFlagged));
  if (missing.length) {
    v('labels.required', `Missing required label(s): ${missing.join(', ')}.`, missing.map((k) => (k === 'owner' ? '--owner <email>' : `--label ${k}=<value>`)).join(' '));
  }

  return { resolved, violations };
}
