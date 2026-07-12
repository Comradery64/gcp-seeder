/**
 * Test preload that makes the suite HERMETIC: no test may silently fall back to
 * the developer's real Application Default Credentials. Any code path that calls
 * `resolveAuth` without an injected/mocked auth client will now fail fast (loud)
 * — locally exactly as it does in CI, where there are no credentials.
 *
 * This exists because a non-hermetic test once passed locally (ambient gcloud
 * ADC) but failed in CI, slipping a broken commit into a release. Blocking ADC
 * here means "green locally" and "green in CI" mean the same thing.
 */
process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nonexistent/gcp-seeder-tests-no-adc';
process.env.CLOUDSDK_CONFIG = '/nonexistent/gcp-seeder-tests-no-adc';
process.env.GOOGLE_CLOUD_PROJECT = '';
process.env.GCLOUD_PROJECT = '';
// google-auth-library / gcp-metadata: skip the GCE metadata-server probe so a
// missing credential fails immediately instead of hanging on a network timeout.
process.env.METADATA_SERVER_DETECTION = 'none';
