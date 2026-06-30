import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Helpers for auto-managing the Google Cloud SDK (gcloud) so the user never has
 * to install it or run an ADC login by hand. This is what makes the bootstrap
 * "one browser click" instead of "go set up gcloud first."
 */

const HOME = os.homedir();

/** Common install locations to probe before giving up. */
function candidateGcloudPaths(): string[] {
  const exe = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
  return [
    path.join(HOME, 'google-cloud-sdk', 'bin', exe),
    path.join(HOME, '.local', 'google-cloud-sdk', 'bin', exe),
    `/usr/local/google-cloud-sdk/bin/${exe}`,
    `/opt/homebrew/bin/${exe}`,
    `/usr/local/bin/${exe}`,
  ];
}

/** Resolve a usable gcloud binary, or null if none is installed. */
export async function findGcloud(): Promise<string | null> {
  // 1. On PATH?
  const onPath = await which('gcloud');
  if (onPath) return onPath;
  // 2. Known install dirs.
  for (const p of candidateGcloudPaths()) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** The well-known Application Default Credentials path for this OS. */
export function adcPath(): string {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  const configDir =
    process.env.CLOUDSDK_CONFIG ??
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'gcloud')
      : path.join(HOME, '.config', 'gcloud'));
  return path.join(configDir, 'application_default_credentials.json');
}

/** True if ADC credentials already exist locally (existence only — no contents read). */
export function hasAdc(): boolean {
  return existsSync(adcPath());
}

/**
 * Install the Google Cloud SDK headlessly into the user's home dir (no sudo).
 * Returns the path to the freshly-installed gcloud binary.
 */
export async function installGcloud(log: (m: string) => void): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error(
      'Automatic gcloud install is not supported on Windows.\n' +
        'Install it from https://cloud.google.com/sdk/docs/install then re-run `gcp-seeder init`.',
    );
  }
  log('Installing the Google Cloud SDK into your home directory (no sudo, ~1-2 min)…');
  const cmd =
    'curl -sSL https://sdk.cloud.google.com | bash -s -- ' +
    `--disable-prompts --install-dir="${HOME}"`;
  await runInherit('bash', ['-c', cmd], { CLOUDSDK_CORE_DISABLE_PROMPTS: '1' });

  const gcloud = await findGcloud();
  if (!gcloud) {
    throw new Error(
      'gcloud install reported success but the binary could not be located. ' +
        `Expected it under ${path.join(HOME, 'google-cloud-sdk', 'bin')}.`,
    );
  }
  log('✓ gcloud installed');
  return gcloud;
}

/**
 * Run the interactive ADC browser login. This is the single human step: gcloud
 * opens a browser, the user picks an account, and credentials (with the
 * cloud-platform scope, which ADC login requests by default) are written to
 * the well-known path. No secret is printed to the terminal.
 */
export async function runAdcLogin(gcloudPath: string, log: (m: string) => void): Promise<void> {
  log('Opening a browser to authorize Google Cloud access…');
  log('(Pick the Google account you want gcp-seeder to act as.)');
  await runInherit(gcloudPath, ['auth', 'application-default', 'login']);
  if (!hasAdc()) {
    throw new Error('Login finished but no ADC file was written. Please try `gcp-seeder init` again.');
  }
  log('✓ Application Default Credentials saved');
}

/**
 * Mint an ADC access token via the gcloud CLI. gcloud can satisfy reauth
 * challenges (invalid_rapt) that the Node client cannot. Returns null if gcloud
 * is absent or can't produce a token. The token is returned, never logged.
 */
export async function gcloudAdcAccessToken(): Promise<string | null> {
  const gcloud = await findGcloud();
  if (!gcloud) return null;
  return new Promise((resolve) => {
    const child = spawn(gcloud, ['auth', 'application-default', 'print-access-token']);
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

// --- internals -------------------------------------------------------------

function which(bin: string): Promise<string | null> {
  // `command -v` is a shell builtin, so run it through bash without `shell:true`
  // (which triggers a Node deprecation warning). `bin` is always an internal
  // literal, never user input.
  const [command, args] =
    process.platform === 'win32'
      ? ['where', [bin]]
      : ['bash', ['-c', `command -v ${bin}`]];
  return new Promise((resolve) => {
    const child = spawn(command as string, args as string[]);
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const first = out.split('\n')[0]?.trim();
      resolve(code === 0 && first ? first : null);
    });
  });
}

function runInherit(
  command: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`\`${command}\` exited with code ${code}`));
    });
  });
}
