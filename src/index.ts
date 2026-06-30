/**
 * gcp-seeder — programmatically bootstrap a Google Cloud project.
 *
 * Library entry point. The CLI (`gcp-seeder`) is a thin wrapper over `seedProject`.
 */
export { seedProject, generateProjectId } from './seeder.js';
export { auditCloud } from './audit.js';
export { destroyProjects } from './destroy.js';
export { resolveAuth, buildOAuthClientFromEnv, CLOUD_PLATFORM_SCOPE, AuthError } from './auth.js';
export { findGcloud, installGcloud, runAdcLogin, hasAdc, adcPath } from './gcloud.js';
export { API_CATALOG, BOOTSTRAP_APIS, PRESETS, lookupApi } from './apis.js';
export type {
  SeedOptions,
  SeedResult,
  CredentialTargets,
  ApiDefinition,
  AuditOptions,
  AuditReport,
  ProjectAudit,
  ServiceAccountAudit,
  KeyAudit,
  DestroyOptions,
  DestroyResult,
  ProjectDestroyResult,
} from './types.js';
