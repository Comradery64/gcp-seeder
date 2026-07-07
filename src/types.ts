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
  /** Matched one of the flagPatterns. */
  orphanCandidate: boolean;
  /** False if we couldn't list service accounts (no permission / not active). */
  accessible: boolean;
  serviceAccounts: ServiceAccountAudit[];
}

export interface AuditReport {
  scannedProjects: number;
  projects: ProjectAudit[];
  /** Flat list of every static (user-managed) SA key found — the headline risk. */
  staticKeys: Array<{ projectId: string; serviceAccount: string; keyId: string; createdAt?: string }>;
  /**
   * SAs worth checking in the Admin console for a domain-wide-delegation grant.
   * DWD cannot be listed via any public API, so the best we can do is surface the
   * client ids to verify by hand. We list SAs that hold a key (DWD is inert without one).
   */
  dwdCheckList: Array<{ projectId: string; serviceAccount: string; clientId: string }>;
  warnings: string[];
}

export interface DestroyOptions {
  /** REQUIRED. Explicit project ids to tear down — never discovered or wildcarded. */
  projectIds: string[];
  /** Only revoke static SA keys; keep the project and service accounts. Default false. */
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
  projectDeleted: boolean;
  /** Client ids whose DWD grants must be removed by hand (no API for it). */
  dwdClientIds: string[];
}

export interface DestroyResult {
  dryRun: boolean;
  keysOnly: boolean;
  projects: ProjectDestroyResult[];
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
  /** Non-fatal problems (e.g. OAuth client could not be created automatically). */
  warnings: string[];
}
