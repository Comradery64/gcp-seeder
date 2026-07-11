import type { AuthClient } from 'google-auth-library';

/** A selectable Google API in the curated catalog. */
export interface ApiDefinition {
  /** The serviceusage service name, e.g. "gmail.googleapis.com". */
  service: string;
  /** Human label shown in the interactive menu. */
  label: string;
  /** One-line description of what the API is for. */
  description: string;
  /** Catalog grouping used to organize the menu. */
  group: 'workspace' | 'ai' | 'platform' | 'data' | 'other';
}

/**
 * A named service account to create + key. Use this when you need more than one
 * SA (e.g. one per consumer, for least privilege) or meaningful names/filenames.
 * `credentials.serviceAccount: true` is the shorthand for a single default SA.
 */
export interface ServiceAccountSpec {
  /**
   * The account id (the local part of the SA email). GCP rules: 6-30 chars,
   * lowercase letters/digits/hyphens, must start with a letter.
   */
  id: string;
  /** Human-friendly display name shown in the console. */
  displayName: string;
  /** Filename for the JSON key, relative to `outputDir` (e.g. "directory-reader-sa.json"). */
  keyFile: string;
  /**
   * OAuth scopes this SA is meant to use via domain-wide delegation. Guidance
   * ONLY — DWD grants have no public API, so the seeder surfaces the SA's client
   * id + these scopes for you to authorize by hand in the Admin console.
   */
  dwdScopes?: string[];
}

/**
 * A keyless-auth target for Workload Identity Federation. Only GitHub OIDC is
 * supported today; `provider` is kept explicit so other OIDC providers can be
 * added without changing the flag shape.
 */
export interface WifTarget {
  provider: 'github';
  /** "owner/repo" whose GitHub Actions OIDC tokens may impersonate the SA. */
  repo: string;
}

/** The Workload Identity Federation resources a seed run created (or reused). */
export interface WifResult {
  /** Workload identity pool id. */
  poolId: string;
  /** OIDC provider id within the pool. */
  providerId: string;
  /**
   * Full provider resource name (numeric project form) — paste this as
   * `workload_identity_provider` in `google-github-actions/auth`.
   */
  providerResourceName: string;
  /** SA that federated principals may impersonate. */
  serviceAccountEmail: string;
  /** "owner/repo" the provider is locked to. */
  repo: string;
  /** Path to the written `github-actions-auth.yml` snippet, if `outputDir` was set. */
  workflowSnippetFile?: string;
}

/** An OIDC provider inside a workload identity pool (as seen by audit/destroy). */
export interface WifProviderInfo {
  providerId: string;
  displayName?: string;
  /** OIDC issuer this provider trusts, e.g. GitHub's token issuer. */
  issuerUri?: string;
  /** CEL condition scoping which tokens are accepted (e.g. a specific repo). */
  attributeCondition?: string;
  disabled?: boolean;
}

/** A workload identity pool and its providers (as seen by audit/destroy). */
export interface WifPoolInfo {
  poolId: string;
  displayName?: string;
  disabled?: boolean;
  providers: WifProviderInfo[];
}

/** Which credential artifacts the seeder should produce. */
export interface CredentialTargets {
  /**
   * Create a service account and download a JSON key
   * (server-to-server / domain-wide delegation). Writes `service-account.json`.
   */
  serviceAccount: boolean;
  /**
   * Attempt to create an OAuth client + consent screen for 3-legged user auth.
   * Writes `client_secret.json`. Reliably works only for Workspace org projects;
   * see README for the personal-account caveat.
   */
  oauthClient: boolean;
}

export interface SeedOptions {
  /**
   * Desired project ID. Must satisfy GCP rules (6-30 chars, lowercase letters,
   * digits and hyphens, start with a letter). Omit to auto-generate a unique id.
   */
  projectId?: string;
  /** Friendly display name for the project. Defaults to the project id. */
  displayName?: string;
  /**
   * Parent resource, e.g. "organizations/123456789" or "folders/987654321".
   * Omit to create a standalone (no-parent) project under the caller's account.
   */
  parent?: string;
  /** serviceusage service names to enable, e.g. ["gmail.googleapis.com"]. */
  apis: string[];
  /** What credential files to generate. */
  credentials: CredentialTargets;
  /**
   * Explicit service accounts to create (each gets its own JSON key). When
   * provided, these are minted in addition to any implied by
   * `credentials.serviceAccount`. Use for multi-SA / least-privilege setups.
   */
  serviceAccounts?: ServiceAccountSpec[];
  /**
   * Set up keyless auth (Workload Identity Federation) for the created service
   * account(s) instead of — or alongside — a downloadable key. Requires at
   * least one service account to bind to. Only GitHub OIDC is supported today.
   */
  wif?: WifTarget;
  /**
   * Time-to-live for the project, e.g. "30d", "2w", "12h". When set, the project
   * is stamped with an `expires` label so `sweep` can find and delete it once it
   * lapses. Omit for a project with no expiry.
   */
  ttl?: string;
  /**
   * Reconcile mode (used by manifest apply): treat an already-existing project
   * or service account as success and continue, rather than failing. Existing
   * service accounts are reused without minting a new key. Default false, which
   * keeps a plain `seed` failing loudly on a duplicate project id.
   */
  reconcile?: boolean;
  /**
   * Support email shown on the OAuth consent screen. Required when
   * `credentials.oauthClient` is true.
   */
  supportEmail?: string;
  /** Title shown on the OAuth consent screen. Defaults to the display name. */
  consentScreenTitle?: string;
  /**
   * Directory to write credential files into. Created if missing.
   * Defaults to "./credentials".
   */
  outputDir?: string;
  /**
   * Pre-authorized auth client with the cloud-platform scope. If omitted, the
   * seeder falls back to Application Default Credentials (ADC).
   */
  auth?: AuthClient;
  /** Receives human-readable progress lines. Defaults to console.log. */
  logger?: (message: string) => void;
}

export interface AuditOptions {
  /** Restrict the scan to these project ids. Default: every project the identity can see. */
  projectIds?: string[];
  /**
   * Glob patterns (only `*` supported) that mark a project as an "orphan candidate"
   * in the report. Default: ["gyb-project-*", "seed-*"]. Does not restrict the scan.
   */
  flagPatterns?: string[];
  /** Max concurrent project scans. Default 8. */
  concurrency?: number;
  /**
   * Flag user-managed SA keys older than this duration ("90d", "1w") as stale.
   * When set, the report's `staleKeys` lists every key past this age. Omit to
   * skip the staleness check (`staleKeys` stays empty).
   */
  maxKeyAge?: string;
  /** Reference "now" for key-age math. Injectable for tests; defaults to the wall clock. */
  now?: Date;
  /** Pre-authorized cloud-platform auth client. Falls back to ADC. */
  auth?: AuthClient;
  /** Receives progress lines. Default: no-op. */
  logger?: (message: string) => void;
}

export interface KeyAudit {
  keyId: string;
  validAfterTime?: string;
  validBeforeTime?: string;
}

export interface ServiceAccountAudit {
  email: string;
  /** OAuth client id (uniqueId) — this is what a domain-wide-delegation grant is keyed on. */
  clientId: string;
  disabled: boolean;
  userManagedKeys: KeyAudit[];
}

export interface ProjectAudit {
  projectId: string;
  projectNumber?: string;
  name?: string;
  lifecycleState?: string;
  createTime?: string;
  /** Labels on the project (e.g. seeded-by, seeded-at, expires), if any. */
  labels?: Record<string, string>;
  /** Owned by the seeder: carries the `seeded-by` label OR matched a flagPattern. */
  orphanCandidate: boolean;
  /** False if we couldn't list service accounts (no permission / not active). */
  accessible: boolean;
  serviceAccounts: ServiceAccountAudit[];
  /** Workload identity federation pools found in the project (keyless-auth surface). */
  wifPools: WifPoolInfo[];
}

export interface AuditReport {
  scannedProjects: number;
  projects: ProjectAudit[];
  /** Flat list of every static (user-managed) SA key found — the headline risk. */
  staticKeys: Array<{ projectId: string; serviceAccount: string; keyId: string; createdAt?: string; ageDays?: number }>;
  /**
   * Subset of `staticKeys` older than `maxKeyAge` — the keys most worth rotating.
   * Empty unless `maxKeyAge` was set.
   */
  staleKeys: Array<{ projectId: string; serviceAccount: string; keyId: string; createdAt?: string; ageDays?: number }>;
  /**
   * SAs worth checking in the Admin console for a domain-wide-delegation grant.
   * DWD cannot be listed via any public API, so the best we can do is surface the
   * client ids to verify by hand. We list SAs that hold a key (DWD is inert without one).
   */
  dwdCheckList: Array<{ projectId: string; serviceAccount: string; clientId: string }>;
  /**
   * Flat list of every workload-identity OIDC provider found — the keyless-auth
   * equivalent of `staticKeys`. One row per provider.
   */
  wifProviders: Array<{
    projectId: string;
    poolId: string;
    providerId: string;
    issuerUri?: string;
    attributeCondition?: string;
  }>;
  warnings: string[];
}

export interface DestroyOptions {
  /** REQUIRED. Explicit project ids to tear down — never discovered or wildcarded. */
  projectIds: string[];
  /**
   * Revoke standing credentials (static SA keys + WIF pools) but keep the
   * project and service accounts. Default false.
   */
  keysOnly?: boolean;
  /** Actually perform deletions. Default false (dry-run). */
  apply?: boolean;
  /** Allow targeting projects that don't match an orphan pattern. Default false. */
  force?: boolean;
  /** Orphan patterns used for the safety check. Default: ["gyb-project-*", "seed-*"]. */
  flagPatterns?: string[];
  auth?: AuthClient;
  logger?: (message: string) => void;
}

export interface ProjectDestroyResult {
  projectId: string;
  matchedPattern: boolean;
  /** Set when the project was not acted on (with the reason). */
  skipped?: string;
  /** "email:keyId" entries that were deleted (or would be, in dry-run). */
  keysDeleted: string[];
  serviceAccountsAffected: string[];
  /** Workload identity pool ids torn down (or would be, in dry-run). */
  wifPoolsDeleted: string[];
  projectDeleted: boolean;
  /** Client ids whose DWD grants must be removed by hand (no API for it). */
  dwdClientIds: string[];
}

export interface DestroyResult {
  dryRun: boolean;
  keysOnly: boolean;
  projects: ProjectDestroyResult[];
}

export interface SweepOptions {
  /** Actually delete the matching projects. Default false (dry-run). */
  apply?: boolean;
  /**
   * Also sweep seeder-owned projects older than this duration ("30d", "2w")
   * even if they carry no `expires` label. Omit to sweep only expired projects.
   */
  maxAge?: string;
  /**
   * Glob patterns used as a fallback to claim ownership of projects created
   * before labels existed. Default: ["gyb-project-*", "seed-*"].
   */
  flagPatterns?: string[];
  /** Reference "now" for expiry/age math. Injectable for tests; defaults to the wall clock. */
  now?: Date;
  auth?: AuthClient;
  logger?: (message: string) => void;
}

/** One seeder-owned project considered by `sweep`. */
export interface SweepCandidate {
  projectId: string;
  /** How we claimed it: by `seeded-by` label, or by glob fallback. */
  ownedBy: 'label' | 'glob';
  seededAt?: string;
  expires?: string;
  ageDays?: number;
  /** Past its `expires` label. */
  expired: boolean;
  /** Older than `maxAge` (only computed when `maxAge` is set). */
  stale: boolean;
  /** Will be (or was) swept. */
  selected: boolean;
}

export interface SweepResult {
  dryRun: boolean;
  /** Seeder-owned projects considered (after ownership filtering). */
  scanned: number;
  candidates: SweepCandidate[];
  /** Teardown outcome for the selected projects (undefined if none selected). */
  destroy?: DestroyResult;
}

export interface RotateOptions {
  /** Project the service account lives in. */
  projectId: string;
  /** Service account email whose key(s) to rotate. */
  serviceAccountEmail: string;
  /**
   * Rotate only this key id. Omit to rotate every user-managed key on the SA
   * (mint one fresh key, then retire all pre-existing ones).
   */
  keyId?: string;
  /** Directory to write the new key into. Defaults to "./credentials". */
  outputDir?: string;
  /** Actually mint + retire keys. Default false (dry-run). */
  apply?: boolean;
  auth?: AuthClient;
  logger?: (message: string) => void;
}

export interface RotateResult {
  dryRun: boolean;
  projectId: string;
  serviceAccountEmail: string;
  /** The freshly minted key id (undefined in dry-run, or if minting was blocked). */
  newKeyId?: string;
  /** Path the new key was written to (undefined in dry-run). */
  newKeyFile?: string;
  /** Key ids retired (disabled then deleted), or that would be in dry-run. */
  retiredKeyIds: string[];
  /** Non-fatal problems (e.g. key creation blocked by org policy). */
  warnings: string[];
}

export interface ExportOptions {
  /** Project to read and render as Terraform. */
  projectId: string;
  auth?: AuthClient;
  logger?: (message: string) => void;
}

export interface ExportResult {
  projectId: string;
  /** The rendered Terraform HCL. */
  hcl: string;
  counts: { services: number; serviceAccounts: number; wifPools: number };
}

/**
 * A domain-wide-delegation authorization the caller must complete by hand.
 * There is no public API to create DWD grants, so the seeder returns the exact
 * client id + scopes to paste into the Admin console.
 */
export interface DwdGrant {
  serviceAccountEmail: string;
  /** The SA's OAuth client id (uniqueId) — what a DWD grant is keyed on. */
  clientId: string;
  /** Scopes to authorize for this client id. */
  scopes: string[];
}

export interface SeedResult {
  projectId: string;
  projectNumber: string;
  enabledApis: string[];
  /** Labels stamped on the project (seeded-by, seeded-at, and expires when a ttl was set). */
  labels: Record<string, string>;
  /**
   * The first service account created, if any. Retained for backwards
   * compatibility; prefer `serviceAccounts` for multi-SA setups.
   */
  serviceAccount?: {
    email: string;
    keyFile: string;
  };
  /** Every service account created, in order. */
  serviceAccounts?: Array<{
    email: string;
    /** Path to the JSON key, or null if key creation was blocked (see `warnings`). */
    keyFile: string | null;
    /** OAuth client id (uniqueId) — used for domain-wide-delegation grants. */
    clientId: string;
  }>;
  /**
   * Domain-wide-delegation grants still to authorize by hand (one per SA that
   * declared `dwdScopes`). No API can create these.
   */
  dwdGrants?: DwdGrant[];
  oauthClient?: {
    clientSecretsFile: string;
  };
  /**
   * Keyless-auth (Workload Identity Federation) setup, if `--wif` was used.
   * One entry per service account bound to the target repo.
   */
  wif?: WifResult[];
  /** Non-fatal problems (e.g. OAuth client could not be created automatically). */
  warnings: string[];
}
