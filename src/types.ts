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

export interface SeedResult {
  projectId: string;
  projectNumber: string;
  enabledApis: string[];
  serviceAccount?: {
    email: string;
    keyFile: string;
  };
  oauthClient?: {
    clientSecretsFile: string;
  };
  /** Non-fatal problems (e.g. OAuth client could not be created automatically). */
  warnings: string[];
}
