/** The seed flags that say *what* to create. */
export interface SeedIntent {
  name?: string;
  projectId?: string;
  preset?: string;
  apis?: string;
  serviceAccount?: boolean;
  serviceAccounts?: string;
  wif?: string;
  oauthClient?: boolean;
}

/**
 * Refuse a non-interactive seed that says nothing about what to create (e.g. a
 * bare `--yes`): it would silently create an empty project with default
 * settings. Interactive runs are fine — the wizard asks.
 */
export function assertSeedHasIntent(opts: SeedIntent, interactive: boolean): void {
  if (interactive) return;
  const said = [opts.name, opts.projectId, opts.preset, opts.apis, opts.serviceAccount, opts.serviceAccounts, opts.wif, opts.oauthClient].some(Boolean);
  if (said) return;
  throw new Error(
    'Nothing to seed: --yes/--json with no --name, --project-id, --preset, --apis, --service-account(s), --wif or ' +
      '--oauth-client would create an empty project with default settings. Pass at least one, use --manifest, ' +
      'or drop --yes to use the wizard.',
  );
}
