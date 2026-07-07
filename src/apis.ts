import type { ApiDefinition, ServiceAccountSpec } from './types.js';

/**
 * Curated catalog of commonly-wanted Google APIs.
 *
 * This is intentionally a small, opinionated list — not the full ~400 services
 * Google offers. Add your own freely; `seedProject` accepts any serviceusage
 * service name, the catalog only powers the interactive menu and `--preset`s.
 */
export const API_CATALOG: ApiDefinition[] = [
  // --- Workspace -----------------------------------------------------------
  { service: 'gmail.googleapis.com', label: 'Gmail', description: 'Read, send and manage Gmail', group: 'workspace' },
  { service: 'calendar-json.googleapis.com', label: 'Calendar', description: 'Google Calendar events', group: 'workspace' },
  { service: 'drive.googleapis.com', label: 'Drive', description: 'Files in Google Drive', group: 'workspace' },
  { service: 'sheets.googleapis.com', label: 'Sheets', description: 'Read/write Google Sheets', group: 'workspace' },
  { service: 'docs.googleapis.com', label: 'Docs', description: 'Read/write Google Docs', group: 'workspace' },
  { service: 'people.googleapis.com', label: 'People (Contacts)', description: 'Contacts and profile info', group: 'workspace' },
  { service: 'admin.googleapis.com', label: 'Admin SDK', description: 'Workspace directory & admin', group: 'workspace' },

  // --- AI ------------------------------------------------------------------
  { service: 'aiplatform.googleapis.com', label: 'Vertex AI', description: 'Vertex AI platform & Gemini models', group: 'ai' },
  { service: 'generativelanguage.googleapis.com', label: 'Gemini API', description: 'Generative Language (Gemini) API', group: 'ai' },
  { service: 'speech.googleapis.com', label: 'Speech-to-Text', description: 'Transcribe audio', group: 'ai' },
  { service: 'texttospeech.googleapis.com', label: 'Text-to-Speech', description: 'Synthesize speech', group: 'ai' },
  { service: 'vision.googleapis.com', label: 'Vision', description: 'Image analysis', group: 'ai' },
  { service: 'translate.googleapis.com', label: 'Translation', description: 'Translate text', group: 'ai' },

  // --- Data ----------------------------------------------------------------
  { service: 'bigquery.googleapis.com', label: 'BigQuery', description: 'Serverless data warehouse', group: 'data' },
  { service: 'firestore.googleapis.com', label: 'Firestore', description: 'Document database', group: 'data' },
  { service: 'storage.googleapis.com', label: 'Cloud Storage', description: 'Object storage (buckets)', group: 'data' },
  { service: 'pubsub.googleapis.com', label: 'Pub/Sub', description: 'Messaging & event streaming', group: 'data' },

  // --- Platform ------------------------------------------------------------
  { service: 'run.googleapis.com', label: 'Cloud Run', description: 'Run containers serverlessly', group: 'platform' },
  { service: 'cloudfunctions.googleapis.com', label: 'Cloud Functions', description: 'Event-driven functions', group: 'platform' },
  { service: 'maps-backend.googleapis.com', label: 'Maps', description: 'Maps JavaScript API', group: 'platform' },
];

/**
 * APIs the seeder always needs in order to do its own work (create the project,
 * enable services, mint service-account keys, configure the consent screen).
 * These are enabled in addition to whatever the user picks.
 */
export const BOOTSTRAP_APIS = [
  'cloudresourcemanager.googleapis.com',
  'serviceusage.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  // Required only when creating an OAuth client / consent screen via the IAP
  // brands workaround. Harmless to enable otherwise.
  'iap.googleapis.com',
];

/** Named bundles for non-interactive use (`--preset gmail`). */
export const PRESETS: Record<string, string[]> = {
  gmail: ['gmail.googleapis.com'],
  workspace: [
    'gmail.googleapis.com',
    'calendar-json.googleapis.com',
    'drive.googleapis.com',
    'sheets.googleapis.com',
    'docs.googleapis.com',
  ],
  ai: ['aiplatform.googleapis.com', 'generativelanguage.googleapis.com'],
};

/**
 * The read-only Workspace Directory scopes a directory-sync tool typically
 * needs (users, groups, and group members). Authorized via domain-wide
 * delegation in the Admin console — there is no API to grant them.
 */
export const DIRECTORY_READONLY_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
];

/**
 * A richer preset that provisions service accounts (with keys), not just APIs.
 * `--preset <name>` picks these up the same way it picks up API-only PRESETS.
 */
export interface ProvisioningPreset {
  /** APIs to enable (in addition to the always-on bootstrap set). */
  apis: string[];
  /** Service accounts to create, each with its own downloaded key. */
  serviceAccounts: ServiceAccountSpec[];
  /** Extra human notes printed after seeding (e.g. manual follow-ups). */
  notes?: string[];
}

/**
 * Provisioning presets — bundles that create service accounts too. Kept separate
 * from the API-only PRESETS so `seedProject` stays a thin primitive.
 */
export const PROVISIONING_PRESETS: Record<string, ProvisioningPreset> = {
  // Provision a project to read a Google Workspace directory from an external
  // tool (SSO sync, an identity bridge, an org chart importer, …). Enables the
  // Admin SDK and creates a read-only Directory service account whose scopes you
  // then authorize by hand via domain-wide delegation.
  //
  // Need more than one consumer (least privilege = one SA each)? Use the generic
  // `--service-accounts a,b,c --dwd-scopes <csv>` flags instead of this preset.
  'directory-sync': {
    apis: ['admin.googleapis.com'],
    serviceAccounts: [
      {
        id: 'directory-reader',
        displayName: 'Directory reader (read-only)',
        keyFile: 'directory-reader-sa.json',
        dwdScopes: DIRECTORY_READONLY_SCOPES,
      },
    ],
    notes: [
      'This service account impersonates a Workspace admin via domain-wide delegation — ' +
        "set that admin email in your consuming tool's own config, not here.",
      'These scopes are read-only. Writing to the directory (e.g. group membership) needs a ' +
        'separate DWD grant for the corresponding write scope (e.g. admin.directory.group.member).',
    ],
  },
};

export function lookupProvisioningPreset(name: string): ProvisioningPreset | undefined {
  return PROVISIONING_PRESETS[name];
}

const CATALOG_BY_SERVICE = new Map(API_CATALOG.map((a) => [a.service, a]));

export function lookupApi(service: string): ApiDefinition | undefined {
  return CATALOG_BY_SERVICE.get(service);
}
