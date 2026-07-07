#!/usr/bin/env node
import { checkbox, confirm, input, select, Separator } from '@inquirer/prompts';
import { Command } from 'commander';
import { API_CATALOG, PRESETS, PROVISIONING_PRESETS } from './apis.js';
import { auditCloud } from './audit.js';
import { destroyProjects } from './destroy.js';
import { findGcloud, hasAdc, installGcloud, runAdcLogin } from './gcloud.js';
import { generateProjectId, seedProject } from './seeder.js';
import type { AuditReport, CredentialTargets, DestroyResult, SeedResult, ServiceAccountSpec } from './types.js';

const ALL_PRESETS = [...Object.keys(PRESETS), ...Object.keys(PROVISIONING_PRESETS)];

const log = (m: string) => console.log(m);

const program = new Command();

program
  .name('gcp-seeder')
  .description('Bootstrap a fully wired Google Cloud project in one command.')
  .version('0.1.0');

program
  .command('seed', { isDefault: true })
  .description('Create a project, enable APIs, and generate credentials.')
  .option('-p, --project-id <id>', 'Project id (auto-generated if omitted)')
  .option('-n, --name <name>', 'Project display name')
  .option('--parent <resource>', 'Parent, e.g. organizations/123 or folders/456')
  .option('--apis <list>', 'Comma-separated service names to enable')
  .option('--preset <name>', `Use a preset: ${ALL_PRESETS.join(', ')}`)
  .option('--service-account', 'Create a single default service account + key')
  .option('--service-accounts <names>', 'Create one named service account + key per comma-separated name')
  .option('--dwd-scopes <csv>', 'OAuth scopes to surface for domain-wide delegation on the created SAs')
  .option('--oauth-client', 'Create an OAuth client + consent screen')
  .option('--support-email <email>', 'Consent-screen support email (for --oauth-client)')
  .option('--output-dir <dir>', 'Where to write credentials', './credentials')
  .option('-y, --yes', 'Skip prompts; use flags/defaults non-interactively')
  .action(run);

program
  .command('audit')
  .description('Read-only: find orphan projects, static SA keys, and DWD client ids to check.')
  .option('--project <id...>', 'Restrict the scan to these project ids')
  .option('--flag <pattern...>', 'Glob patterns to mark as orphan candidates (default: gyb-project-*, seed-*)')
  .option('--concurrency <n>', 'Max concurrent project scans', (v) => parseInt(v, 10), 8)
  .option('--json', 'Emit the raw report as JSON')
  .action(async (opts: { project?: string[]; flag?: string[]; concurrency: number; json?: boolean }) => {
    const report = await auditCloud({
      projectIds: opts.project,
      flagPatterns: opts.flag,
      concurrency: opts.concurrency,
      logger: opts.json ? undefined : log,
    });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printAuditReport(report);
    }
  });

program
  .command('destroy')
  .description('Tear down explicitly-named projects (revoke static keys + soft-delete). Dry-run by default.')
  .requiredOption('--project <id...>', 'Project id(s) to tear down (required, explicit — no wildcards)')
  .option('--keys-only', 'Only revoke static SA keys; keep the project + service accounts')
  .option('--apply', 'Actually delete (default is a dry-run)')
  .option('--force', "Allow projects that don't match an orphan pattern (gyb-project-*/seed-*)")
  .option('-y, --yes', 'Skip the interactive confirmation (for scripts)')
  .action(async (opts: { project: string[]; keysOnly?: boolean; apply?: boolean; force?: boolean; yes?: boolean }) => {
    // Show the plan first (always a dry-run pass), so the user sees exactly what's targeted.
    const plan = await destroyProjects({
      projectIds: opts.project,
      keysOnly: opts.keysOnly,
      force: opts.force,
      apply: false,
      logger: log,
    });
    printDestroyResult(plan);

    if (!opts.apply) {
      console.log('\nDry-run only. Re-run with --apply to execute.');
      return;
    }

    const actionable = plan.projects.filter((p) => !p.skipped);
    if (actionable.length === 0) {
      console.log('\nNothing to do.');
      return;
    }
    if (!opts.yes) {
      const ok = await confirm({
        message: `This will PERMANENTLY revoke ${plan.projects.reduce((n, p) => n + p.keysDeleted.length, 0)} key(s)` +
          `${opts.keysOnly ? '' : ` and soft-delete ${actionable.length} project(s)`}. Proceed?`,
        default: false,
      });
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    const result = await destroyProjects({
      projectIds: opts.project,
      keysOnly: opts.keysOnly,
      force: opts.force,
      apply: true,
      logger: log,
    });
    console.log('\n✓ Done.');
    printDestroyResult(result);
  });

program
  .command('init')
  .description('One-time setup: install gcloud if needed and sign in (writes ADC credentials).')
  .option('-y, --yes', 'Auto-install gcloud without asking')
  .action(async (opts: { yes?: boolean }) => {
    await ensureBootstrap({ interactive: !opts.yes, autoInstall: Boolean(opts.yes) });
    console.log('\n✓ You\'re ready. Next:  gcp-seeder seed');
  });

program.parseAsync().catch((err) => {
  // Inquirer throws this when the user hits Ctrl-C — exit quietly.
  if (err?.name === 'ExitPromptError') process.exit(130);
  const msg = err instanceof Error ? err.message : String(err);
  // ADC sessions expire / can require reauth; surface a human instruction, not raw JSON.
  if (/invalid_rapt|reauth|invalid_grant/i.test(msg)) {
    console.error('\n✗ Your Google credentials need re-authentication (the session expired or reauth is required).');
    console.error('  Run:  gcloud auth application-default login    (or:  gcp-seeder init)');
    process.exit(1);
  }
  console.error(`\n✗ ${msg}`);
  process.exit(1);
});

interface CliOptions {
  projectId?: string;
  name?: string;
  parent?: string;
  apis?: string;
  preset?: string;
  serviceAccount?: boolean;
  serviceAccounts?: string;
  dwdScopes?: string;
  oauthClient?: boolean;
  supportEmail?: string;
  outputDir: string;
  yes?: boolean;
}

async function run(opts: CliOptions): Promise<void> {
  const interactive = !opts.yes;

  // Preflight: make sure we actually have credentials before doing any work.
  await ensureBootstrap({ interactive, autoInstall: Boolean(opts.yes) });

  const promptedId =
    opts.projectId ??
    (interactive ? await input({ message: 'Project id (blank = auto-generate):' }) : '');
  const projectId = promptedId.trim() || generateProjectId();

  // A provisioning preset (e.g. directory-sync) also declares service accounts,
  // as do the generic --service-accounts / --dwd-scopes flags — either short-
  // circuits the interactive credential prompt.
  const provisioning = opts.preset ? PROVISIONING_PRESETS[opts.preset] : undefined;
  let apis: string[];
  let credentials: CredentialTargets;
  let serviceAccounts = resolveServiceAccounts(opts); // from generic flags (may be [])
  const notes = provisioning?.notes;

  if (provisioning) {
    const extra = opts.apis ? opts.apis.split(',').map((s) => s.trim()).filter(Boolean) : [];
    apis = [...new Set([...provisioning.apis, ...extra])];
    credentials = { serviceAccount: false, oauthClient: Boolean(opts.oauthClient) };
    // Explicit --service-accounts overrides the preset's default SA set.
    if (serviceAccounts.length === 0) serviceAccounts = provisioning.serviceAccounts;
  } else if (serviceAccounts.length) {
    apis = await resolveApis(opts, interactive);
    credentials = { serviceAccount: false, oauthClient: Boolean(opts.oauthClient) };
  } else {
    apis = await resolveApis(opts, interactive);
    credentials = await resolveCredentials(opts, interactive);
  }

  let supportEmail = opts.supportEmail;
  if (credentials.oauthClient && !supportEmail && interactive) {
    supportEmail = await input({
      message: 'Support email for the OAuth consent screen:',
      validate: (v) => (v.includes('@') ? true : 'Enter a valid email'),
    });
  }

  const saSummary = serviceAccounts?.length
    ? serviceAccounts.map((s) => s.id).join(', ')
    : credentials.serviceAccount
      ? 'yes (1)'
      : 'no';

  console.log('\nReady to seed:');
  console.log(`  project       ${projectId}`);
  console.log(`  apis          ${apis.length ? apis.join(', ') : '(none)'}`);
  console.log(`  service acct  ${saSummary}`);
  console.log(`  oauth client  ${credentials.oauthClient ? 'yes' : 'no'}`);
  console.log(`  output dir    ${opts.outputDir}\n`);

  if (interactive && !(await confirm({ message: 'Proceed?', default: true }))) {
    console.log('Aborted.');
    return;
  }

  const result = await seedProject({
    projectId,
    displayName: opts.name,
    parent: opts.parent,
    apis,
    credentials,
    serviceAccounts,
    supportEmail,
    outputDir: opts.outputDir,
  });

  console.log('\n✓ Done!');
  console.log(`  Project:  ${result.projectId} (${result.projectNumber})`);
  console.log(`  APIs:     ${result.enabledApis.length} enabled`);
  if (result.serviceAccounts?.length) {
    for (const sa of result.serviceAccounts) {
      if (sa.keyFile) console.log(`  SA key:   ${sa.keyFile}  (${sa.email})`);
      else console.log(`  SA:       ${sa.email}  (created, no key — see warnings)`);
    }
  } else if (result.serviceAccount) {
    console.log(`  SA key:   ${result.serviceAccount.keyFile}`);
  }
  if (result.oauthClient) console.log(`  OAuth:    ${result.oauthClient.clientSecretsFile}`);
  for (const w of result.warnings) console.warn(`  ⚠ ${w}`);

  printDwdGuidance(result, notes);

  console.log(
    `\nConsole: https://console.cloud.google.com/home/dashboard?project=${result.projectId}`,
  );
}

/**
 * Print the manual domain-wide-delegation step. DWD grants have no public API,
 * so we hand the user the exact client id + scope CSV to paste into the Admin
 * console — turning research into one copy-paste.
 */
function printDwdGuidance(result: SeedResult, notes?: string[]): void {
  if (!result.dwdGrants?.length) return;
  console.log('\n⚠ Manual step — authorize domain-wide delegation (no API can do this):');
  console.log('  Admin console → Security → Access and data control → API controls → Domain-wide delegation → Add new');
  for (const g of result.dwdGrants) {
    console.log(`\n  • ${g.serviceAccountEmail}`);
    console.log(`      Client ID: ${g.clientId}`);
    console.log(`      Scopes:    ${g.scopes.join(',')}`);
  }
  if (notes?.length) {
    console.log('\nNotes:');
    for (const n of notes) console.log(`  - ${n}`);
  }
}

async function resolveApis(opts: CliOptions, interactive: boolean): Promise<string[]> {
  if (opts.apis) return opts.apis.split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.preset) {
    const preset = PRESETS[opts.preset];
    if (!preset) throw new Error(`Unknown preset "${opts.preset}". Options: ${Object.keys(PRESETS).join(', ')}`);
    return preset;
  }
  if (!interactive) return [];

  const groups: Array<[string, string]> = [
    ['workspace', 'Google Workspace'],
    ['ai', 'AI & ML'],
    ['data', 'Data & Storage'],
    ['platform', 'Platform'],
    ['other', 'Other'],
  ];
  const choices: Array<{ name: string; value: string } | InstanceType<typeof Separator>> = [];
  for (const [group, heading] of groups) {
    const inGroup = API_CATALOG.filter((a) => a.group === group);
    if (!inGroup.length) continue;
    choices.push(new Separator(`── ${heading} ──`));
    for (const a of inGroup) {
      choices.push({ name: `${a.label} — ${a.description}`, value: a.service });
    }
  }
  return checkbox({
    message: 'Which APIs should this project have? (space to select)',
    choices,
    pageSize: 20,
  });
}

/**
 * Build service-account specs from the generic `--service-accounts` /
 * `--dwd-scopes` flags. One SA per comma-separated name, each written to
 * `<name>-sa.json`, all sharing the same DWD scopes (if any). Returns [] when
 * `--service-accounts` was not passed.
 */
function resolveServiceAccounts(opts: CliOptions): ServiceAccountSpec[] {
  if (!opts.serviceAccounts) return [];
  const scopes = opts.dwdScopes
    ? opts.dwdScopes.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  return opts.serviceAccounts
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, displayName: id, keyFile: `${id}-sa.json`, dwdScopes: scopes }));
}

async function resolveCredentials(opts: CliOptions, interactive: boolean): Promise<CredentialTargets> {
  if (opts.serviceAccount || opts.oauthClient || !interactive) {
    return {
      serviceAccount: Boolean(opts.serviceAccount),
      oauthClient: Boolean(opts.oauthClient),
    };
  }
  const choice = await select({
    message: 'What kind of credentials do you need?',
    choices: [
      { name: 'OAuth client (sign in as a user — personal/3-legged)', value: 'oauth' },
      { name: 'Service account key (server-to-server / Workspace admin)', value: 'sa' },
      { name: 'Both', value: 'both' },
      { name: 'None (just the project + APIs)', value: 'none' },
    ],
  });
  return {
    serviceAccount: choice === 'sa' || choice === 'both',
    oauthClient: choice === 'oauth' || choice === 'both',
  };
}

function printAuditReport(r: AuditReport): void {
  const orphans = r.projects.filter((p) => p.orphanCandidate);
  const deleteReq = r.projects.filter((p) => p.lifecycleState === 'DELETE_REQUESTED');

  console.log(`\nScanned ${r.scannedProjects} project(s).`);
  console.log(`  orphan candidates: ${orphans.length}   already deleting: ${deleteReq.length}`);

  if (orphans.length) {
    console.log('\nOrphan candidates:');
    for (const p of orphans) {
      const state = p.lifecycleState === 'ACTIVE' ? '' : ` [${p.lifecycleState}]`;
      console.log(`  • ${p.projectId}${state}  ${p.name ? `— ${p.name}` : ''}`);
    }
  }

  if (r.staticKeys.length) {
    console.log(`\n⚠ Static service-account keys (${r.staticKeys.length}) — the headline risk:`);
    for (const k of r.staticKeys) {
      console.log(`  • ${k.serviceAccount}`);
      console.log(`      project ${k.projectId} · keyId ${k.keyId}${k.createdAt ? ` · created ${k.createdAt}` : ''}`);
    }
  } else {
    console.log('\n✓ No static (user-managed) service-account keys found.');
  }

  if (r.dwdCheckList.length) {
    console.log('\nDomain-wide delegation — verify these client ids by hand (no API can list DWD):');
    console.log('  Admin console → Security → API controls → Domain-wide delegation');
    for (const d of r.dwdCheckList) {
      console.log(`  • clientId ${d.clientId}  (${d.serviceAccount})`);
    }
  }

  if (r.warnings.length) {
    console.log('\nNotes:');
    for (const w of r.warnings) console.log(`  - ${w}`);
  }
  console.log('\nThis was read-only. (Teardown will live in `gcp-seeder destroy`.)');
}

function printDestroyResult(r: DestroyResult): void {
  const did = r.dryRun ? 'would' : 'did';
  const dwd = new Set<string>();
  console.log(`\n${r.dryRun ? 'Plan' : 'Result'}${r.keysOnly ? ' (keys only)' : ''}:`);
  for (const p of r.projects) {
    if (p.skipped) {
      console.log(`  • ${p.projectId} — SKIPPED: ${p.skipped}`);
      continue;
    }
    console.log(`  • ${p.projectId}${p.matchedPattern ? '' : '  (forced — non-orphan)'}`);
    if (p.keysDeleted.length === 0) {
      console.log('      (no static keys to revoke)');
    } else {
      for (const k of p.keysDeleted) console.log(`      ${did} revoke key ${k}`);
    }
    if (!r.keysOnly) console.log(`      ${did} soft-delete the project`);
    p.dwdClientIds.forEach((c) => dwd.add(c));
  }
  if (dwd.size) {
    console.log('\n⚠ Manual step — remove these DWD client ids (no API can do it):');
    console.log('  Admin console → Security → API controls → Domain-wide delegation');
    for (const c of dwd) console.log(`  • clientId ${c}`);
  }
}

/**
 * Make sure cloud-platform credentials exist, auto-managing gcloud so the user
 * never has to install the SDK or run an ADC login by hand. No-op if ADC is
 * already present.
 */
async function ensureBootstrap({
  interactive,
  autoInstall,
}: {
  interactive: boolean;
  autoInstall: boolean;
}): Promise<void> {
  if (hasAdc()) {
    log('✓ Google Cloud credentials found.');
    return;
  }
  log("No Google Cloud credentials yet — let's set that up (one-time).\n");

  let gcloud = await findGcloud();
  if (!gcloud) {
    if (interactive) {
      const ok = await confirm({
        message: 'The gcloud SDK is not installed. Install it now into your home dir (no sudo)?',
        default: true,
      });
      if (!ok) {
        throw new Error(
          'gcloud is required. Install it from https://cloud.google.com/sdk/docs/install and re-run.',
        );
      }
    } else if (!autoInstall) {
      throw new Error(
        'gcloud is not installed and no credentials were found.\n' +
          'Run `gcp-seeder init` once (it installs gcloud and signs you in), then retry.',
      );
    }
    gcloud = await installGcloud(log);
  }

  await runAdcLogin(gcloud, log);
}
