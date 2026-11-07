/**
 * Project labels the seeder stamps on everything it creates, so resources stay
 * findable and mortal. GCP label rules: keys/values are lowercase, `[a-z0-9_-]`,
 * ≤63 chars; keys must start with a letter. ISO dates (`YYYY-MM-DD`) satisfy the
 * value charset, so we store dates as-is.
 */
export const LABEL_SEEDED_BY = 'seeded-by';
export const LABEL_SEEDED_AT = 'seeded-at';
export const LABEL_EXPIRES = 'expires';
/** The `seeded-by` value that identifies a project as ours. */
export const SEEDER_LABEL_VALUE = 'gcp-seeder';

/** Parse a human duration ("30d", "2w", "12h") into milliseconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+)\s*([hdw])$/.exec(input.trim().toLowerCase());
  if (!m) {
    throw new Error(`Invalid duration ${JSON.stringify(input)}. Use a number followed by h, d, or w (e.g. 30d, 2w, 12h).`);
  }
  const n = Number(m[1]);
  const unitMs = m[2] === 'h' ? 3_600_000 : m[2] === 'd' ? 86_400_000 : 604_800_000;
  return n * unitMs;
}

/** Format a Date as a label-safe `YYYY-MM-DD`. */
export function labelDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The standard label set applied on seed: always `seeded-by` + `seeded-at`,
 * plus `expires` when a ttl is given. `now` is injectable for testing.
 */
export function buildSeedLabels(opts: { ttl?: string; now?: Date } = {}): Record<string, string> {
  const now = opts.now ?? new Date();
  const labels: Record<string, string> = {
    [LABEL_SEEDED_BY]: SEEDER_LABEL_VALUE,
    [LABEL_SEEDED_AT]: labelDate(now),
  };
  if (opts.ttl) {
    labels[LABEL_EXPIRES] = labelDate(new Date(now.getTime() + parseDuration(opts.ttl)));
  }
  return labels;
}

/** True when a project's labels mark it as seeder-created. */
export function isSeederLabeled(labels?: Record<string, string> | null): boolean {
  return labels?.[LABEL_SEEDED_BY] === SEEDER_LABEL_VALUE;
}

/**
 * Whether a project has passed its `expires` label relative to `now`. Projects
 * without an `expires` label never expire on their own — they can still be
 * swept by an age policy (see sweep's `--max-age`), but that's a separate call.
 * Comparison is date-only: a project expires at the end of its `expires` day.
 */
export function isExpired(labels: Record<string, string> | undefined, now: Date): boolean {
  const exp = labels?.[LABEL_EXPIRES];
  return exp ? labelDate(now) > exp : false;
}

/** Days between `seeded-at` and `now`, or undefined if the label is absent/unparsable. */
export function ageInDays(labels: Record<string, string> | undefined, now: Date): number | undefined {
  const seededAt = labels?.[LABEL_SEEDED_AT];
  if (!seededAt) return undefined;
  const then = Date.parse(seededAt);
  if (Number.isNaN(then)) return undefined;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/** Keys gcp-seeder manages itself; user labels may not set them. */
export const RESERVED_LABEL_KEYS = new Set([LABEL_SEEDED_BY, LABEL_SEEDED_AT, LABEL_EXPIRES]);

const LABEL_KEY_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const LABEL_VALUE_RE = /^[a-z0-9_-]{0,63}$/;

/** Throw if any label breaks GCP's rules or uses a reserved key. Returns the labels for chaining. */
export function validateUserLabels(labels: Record<string, string>): Record<string, string> {
  for (const [k, v] of Object.entries(labels)) {
    if (RESERVED_LABEL_KEYS.has(k)) throw new Error(`Label "${k}" is managed by gcp-seeder and can't be set by hand.`);
    if (!LABEL_KEY_RE.test(k)) throw new Error(`Invalid label key "${k}": lowercase letters, digits, _ or -, starting with a letter, max 63.`);
    if (!LABEL_VALUE_RE.test(v)) throw new Error(`Invalid value for label "${k}": lowercase letters, digits, _ or -, max 63.`);
  }
  return labels;
}

/** Parse repeated `--label key=value` arguments into a validated label map. */
export function parseLabelArgs(args: string[] | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const arg of args ?? []) {
    const i = arg.indexOf('=');
    if (i <= 0) throw new Error(`Invalid --label "${arg}": use key=value.`);
    labels[arg.slice(0, i).trim()] = arg.slice(i + 1).trim();
  }
  return validateUserLabels(labels);
}
