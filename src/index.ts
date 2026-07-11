/**
 * gcp-seeder — programmatically bootstrap a Google Cloud project.
 *
 * Library entry point. The CLI (`gcp-seeder`) is a thin wrapper over `seedProject`.
 */
export { seedProject, generateProjectId } from './seeder.js';
export { auditCloud } from './audit.js';
export { destroyProjects } from './destroy.js';
export { sweepProjects } from './sweep.js';
export {
  buildSeedLabels,
  parseDuration,
  isSeederLabeled,
  isExpired,
  ageInDays,
  LABEL_SEEDED_BY,
  LABEL_SEEDED_AT,
  LABEL_EXPIRES,
  SEEDER_LABEL_VALUE,
} from './labels.js';
export { resolveAuth, buildOAuthClientFromEnv, CLOUD_PLATFORM_SCOPE, AuthError } from './auth.js';
export { findGcloud, installGcloud, runAdcLogin, hasAdc, adcPath } from './gcloud.js';
export {
  API_CATALOG,
  BOOTSTRAP_APIS,
  PRESETS,
  PROVISIONING_PRESETS,
  DIRECTORY_READONLY_SCOPES,
  lookupApi,
  lookupProvisioningPreset,
} from './apis.js';
export type { ProvisioningPreset } from './apis.js';
export type {
  SeedOptions,
  SeedResult,
  CredentialTargets,
  ServiceAccountSpec,
  DwdGrant,
  ApiDefinition,
  AuditOptions,
  AuditReport,
  ProjectAudit,
  ServiceAccountAudit,
  KeyAudit,
  DestroyOptions,
  DestroyResult,
  ProjectDestroyResult,
  SweepOptions,
  SweepResult,
  SweepCandidate,
} from './types.js';
