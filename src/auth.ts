import { GoogleAuth, OAuth2Client, type AuthClient } from 'google-auth-library';
import { gcloudAdcAccessToken } from './gcloud.js';

/** The single scope needed to create projects, enable APIs and mint keys. */
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Resolve a cloud-platform-scoped auth client.
 *
 * Default path is Application Default Credentials (ADC): whatever
 * `gcloud auth application-default login` left behind, or a
 * GOOGLE_APPLICATION_CREDENTIALS service-account key, or the metadata server
 * on GCE/Cloud Run. We deliberately do NOT ship a baked-in OAuth client the
 * way GYB does — that would mean embedding a client secret in an open-source
 * tool. Users who want a browser flow can pass their own OAuth2Client via
 * `buildOAuthClientFromEnv` or construct one themselves.
 */
export async function resolveAuth(provided?: AuthClient): Promise<AuthClient> {
  if (provided) return provided;

  let client: AuthClient;
  try {
    client = await new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] }).getClient();
    // gcloud sometimes attaches a quota project to ADC that is itself deleted
    // (e.g. an old throwaway), which makes every call fail with "Project … has
    // been deleted." Our admin operations bill quota to the target project in
    // the request path, so we drop the user-project header entirely to stay robust.
    client.quotaProjectId = undefined;
  } catch (err) {
    // No ADC discoverable at all — try a gcloud-minted token, else guide the user.
    const fallback = await gcloudTokenClient();
    if (fallback) return fallback;
    throw new AuthError(
      'Could not find Application Default Credentials.\n' +
        'Run:  gcp-seeder init   (or: gcloud auth application-default login)\n' +
        '(or set GOOGLE_APPLICATION_CREDENTIALS to a key file, or pass your own ' +
        'auth client via options.auth)\n\n' +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  // Validate the credential can actually mint a token. User ADC sessions can
  // require reauth (invalid_rapt) that the Node client can't satisfy but the
  // gcloud CLI can — fall back to a gcloud-minted token in that case.
  try {
    await client.getAccessToken();
    return client;
  } catch (err) {
    if (isReauthError(err)) {
      const fallback = await gcloudTokenClient();
      if (fallback) return fallback;
    }
    throw new AuthError(
      'Your Google credentials need re-authentication (the session expired or reauth is required).\n' +
        'Run:  gcloud auth application-default login   (or: gcp-seeder init)\n\n' +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}

function isReauthError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /invalid_rapt|reauth|invalid_grant/i.test(m);
}

/** Build an OAuth2 client backed by a gcloud-minted ADC token, or null if unavailable. */
async function gcloudTokenClient(): Promise<OAuth2Client | null> {
  const token = await gcloudAdcAccessToken();
  if (!token) return null;
  const client = new OAuth2Client();
  client.setCredentials({ access_token: token });
  return client;
}

/**
 * Optional: build an installed-app OAuth2 client from env vars, for users who
 * would rather do an interactive browser login than install gcloud. They must
 * supply their OWN client id/secret (e.g. from an existing project's "Desktop
 * app" OAuth client) — nothing is hardcoded here.
 *
 * Returns undefined if the env vars are not set.
 */
export function buildOAuthClientFromEnv(): OAuth2Client | undefined {
  const clientId = process.env.GCP_SEEDER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GCP_SEEDER_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: 'http://localhost',
  });
}
