#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { checkbox, confirm, input, select, Separator } from '@inquirer/prompts';
import { Command } from 'commander';
import { API_CATALOG, PRESETS, PROVISIONING_PRESETS } from './apis.js';
import { auditCloud } from './audit.js';
import { destroyProjects } from './destroy.js';
import { findGcloud, hasAdc, installGcloud, runAdcLogin } from './gcloud.js';
import { createProjectOAuthClient, generateProjectId, seedProject } from './seeder.js';
import { sweepProjects } from './sweep.js';
import { rotateServiceAccountKey } from './rotate.js';
import { parseWifTarget } from './wif.js';
import { exportProjectTerraform } from './export.js';
import { explainGoogleError, formatExplainedError } from './errors.js';
import { resolveBillingAccount } from './billing.js';
import { PRESET_ROLES, validateRoles } from './roles.js';
import { resolveAuth } from './auth.js';
import { preflight } from './preflight.js';
import type { PreflightReport } from './preflight.js';
import { loadManifest, manifestToSeedOptions } from './manifest.js';
import { VERSION } from './version.js';
import type { AuditReport, CredentialTargets, DestroyResult, SeedResult, ServiceAccountSpec, SweepResult } from './types.js';

const ALL_PRESETS = [...Object.keys(PRESETS), ...Object.keys(PROVISIONING_PRESETS)];

const log = (m: string) => console.log(m);

const program = new Command();

program
  .name('gcp-seeder')
  .description('Bootstrap a fully wired Google Cloud project in one command.')
  .version(VERSION);

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
  .option('--wif <target>', 'Keyless CI auth via Workload Identity Federation, e.g. github:owner/repo or gitlab:group/project')
  .option('--billing-account <id>', 'Billing account to link (auto-detected when you have exactly one)')
  .option('--roles <csv>', 'Project IAM roles to grant the created service account(s) (preset default if omitted)')
  .option('--no-wait', 'Do not wait for enabled APIs to become usable')
  .option('--harden', 'Delete the default network and demote the default compute SA')
  .option('--budget <usd>', 'Create a budget with 50/90/100% alerts on the linked billing account', (v) => parseFloat(v))
  .option('--budget-topic <name>', 'Pub/Sub topic to create/reuse for budget notifications')
  .option('--kill-switch', 'Write (not deploy) a Cloud Function that unlinks billing when the budget is exhausted; implies a topic')
  .option('--skip-preflight', 'Skip the read-only preflight checks before creating anything')
  .option('--oauth-client', 'Create an OAuth client + consent screen')
  .option('--support-email <email>', 'Consent-screen support email (for --oauth-client)')
  .option('--output-dir <dir>', 'Where to write credentials', './credentials')
  .option('--ttl <duration>', 'Mark the project to expire after a duration (e.g. 30d, 2w, 12h); sweep deletes it once lapsed')
  .option('--manifest <file>', 'Reconcile from a gcp-seeder.yaml manifest (idempotent; existing project/SAs are reused)')
  .option('--json', 'Emit the SeedResult as JSON (implies --yes; suppresses progress output)')
  .option('-y, --yes', 'Skip prompts; use flags/defaults non-interactively')
  .action(run);

program
  .command('preflight')
  .description('Read-only: check quota, billing, parent permission, org policies and id availability before seeding.')
  .option('-p, --project-id <id>', 'Project id you intend to create')
  .option('--parent <resource>', 'organizations/123 or folders/456')
  .option('--billing-account <id>', 'Billing account you intend to link')
  .option('--apis <list>', 'Comma-separated APIs you intend to enable')
  .option('--preset <name>', `Preset whose APIs you intend to enable: ${ALL_PRESETS.join(', ')}`)
  .option('--service-account', 'Plan includes a downloadable SA key (checks the key-creation org policy)')
  .option('--json', 'Emit the PreflightReport as JSON')
  .action(async (opts: { projectId?: string; parent?: string; billingAccount?: string; apis?: string; preset?: string; serviceAccount?: boolean; json?: boolean }) => {
    const apis = opts.apis
      ? opts.apis.split(',').map((s) => s.trim()).filter(Boolean)
      : opts.preset
        ? (PRESETS[opts.preset] ?? PROVISIONING_PRESETS[opts.preset]?.apis ?? [])
        : [];
    const report = await preflight({
      projectId: opts.projectId,
      parent: opts.parent,
      billingAccount: opts.billingAccount,
      apis,
      wantsServiceAccountKey: Boolean(opts.serviceAccount) || Boolean(PROVISIONING_PRESETS[opts.preset ?? '']),
      logger: opts.json ? undefined : log,
    });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printPreflightReport(report);
    }
    if (!report.ok) process.exitCode = 2;
  });

program
  .command('audit')
  .description('Read-only: find orphan projects, static SA keys, and DWD client ids to check.')
  .option('--project <id...>', 'Restrict the scan to these project ids')
  .option('--flag <pattern...>', 'Glob patterns to mark as orphan candidates (default: gyb-project-*, seed-*)')
  .option('--max-key-age <duration>', 'Flag user-managed SA keys older than this as stale (e.g. 90d, 1w)')
  .option('--concurrency <n>', 'Max concurrent project scans', (v) => parseInt(v, 10), 8)
  .option('--json', 'Emit the raw report as JSON')
  .action(async (opts: { project?: string[]; flag?: string[]; maxKeyAge?: string; concurrency: number; json?: boolean }) => {
    const report = await auditCloud({
      projectIds: opts.project,
      flagPatterns: opts.flag,
      maxKeyAge: opts.maxKeyAge,
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
  .option('--keys-only', 'Revoke standing credentials (static SA keys + WIF pools); keep the project + service accounts')
  .option('--empty', 'Remove the seeder-managed surface (keys, WIF pools, service accounts, budget, non-bootstrap APIs) but keep the project and its id')
  .option('--remove-liens', 'Remove liens before deleting (otherwise a liened project is skipped)')
  .option('--apply', 'Actually delete (default is a dry-run)')
  .option('--force', "Allow projects that don't match an orphan pattern (gyb-project-*/seed-*)")
  .option('--json', 'Emit the DestroyResult as JSON (implies --yes; suppresses progress output)')
  .option('-y, --yes', 'Skip the interactive confirmation (for scripts)')
  .action(async (opts: { project: string[]; keysOnly?: boolean; empty?: boolean; removeLiens?: boolean; apply?: boolean; force?: boolean; json?: boolean; yes?: boolean }) => {
    const json = Boolean(opts.json);
    // Show the plan first (always a dry-run pass), so the user sees exactly what's targeted.
    const plan = await destroyProjects({
      projectIds: opts.project,
      keysOnly: opts.keysOnly,
      empty: opts.empty,
      removeLiens: opts.removeLiens,
      force: opts.force,
      apply: false,
      logger: json ? undefined : log,
    });
    if (!json) printDestroyResult(plan);

    if (!opts.apply) {
      if (json) console.log(JSON.stringify(plan, null, 2));
      else console.log('\nDry-run only. Re-run with --apply to execute.');
      return;
    }

    const actionable = plan.projects.filter((p) => !p.skipped);
    if (actionable.length === 0) {
      if (json) console.log(JSON.stringify(plan, null, 2));
      else console.log('\nNothing to do.');
      return;
    }
    // --json is machine mode: skip the interactive confirmation (like --yes).
    if (!opts.yes && !json) {
      const keyCount = plan.projects.reduce((n, p) => n + p.keysDeleted.length, 0);
      const poolCount = plan.projects.reduce((n, p) => n + p.wifPoolsDeleted.length, 0);
      const ok = await confirm({
        message: `This will PERMANENTLY revoke ${keyCount} key(s)` +
          `${poolCount ? ` and ${poolCount} WIF pool(s)` : ''}` +
          `${opts.empty ? ` and EMPTY ${actionable.length} project(s) (SAs, budget, APIs; project kept)` : opts.keysOnly ? '' : ` and soft-delete ${actionable.length} project(s)`}. Proceed?`,
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
      empty: opts.empty,
      removeLiens: opts.removeLiens,
      force: opts.force,
      apply: true,
      logger: json ? undefined : log,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n✓ Done.');
      printDestroyResult(result);
    }
  });

program
  .command('sweep')
  .description('Find seeder-owned projects and delete the expired/stale ones. Dry-run by default.')
  .option('--max-age <duration>', 'Also sweep projects older than this even without an expiry (e.g. 30d, 2w)')
  .option('--flag <pattern...>', 'Glob fallbacks to claim pre-label projects (default: gyb-project-*, seed-*)')
  .option('--remove-liens', 'Remove liens before deleting (otherwise a liened project is skipped)')
  .option('--apply', 'Actually delete (default is a dry-run)')
  .option('--json', 'Emit the SweepResult as JSON (implies --yes; suppresses progress output)')
  .option('-y, --yes', 'Skip the interactive confirmation (for scripts)')
  .action(async (opts: { maxAge?: string; flag?: string[]; removeLiens?: boolean; apply?: boolean; json?: boolean; yes?: boolean }) => {
    const json = Boolean(opts.json);
    // Always show the plan first (dry-run pass), so the user sees what's targeted.
    const plan = await sweepProjects({
      maxAge: opts.maxAge,
      flagPatterns: opts.flag,
      removeLiens: opts.removeLiens,
      apply: false,
      logger: json ? undefined : log,
    });
    if (!json) printSweepResult(plan);

    const selected = plan.candidates.filter((c) => c.selected);
    if (!opts.apply) {
      if (json) console.log(JSON.stringify(plan, null, 2));
      else if (selected.length) console.log('\nDry-run only. Re-run with --apply to delete the selected project(s).');
      return;
    }
    if (selected.length === 0) {
      if (json) console.log(JSON.stringify(plan, null, 2));
      else console.log('\nNothing to sweep.');
      return;
    }
    // --json is machine mode: skip the interactive confirmation (like --yes).
    if (!opts.yes && !json) {
      const ok = await confirm({
        message: `This will soft-delete ${selected.length} seeder-owned project(s). Proceed?`,
        default: false,
      });
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    const result = await sweepProjects({ maxAge: opts.maxAge, flagPatterns: opts.flag, removeLiens: opts.removeLiens, apply: true, logger: json ? undefined : log });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n✓ Done.');
      if (result.destroy) printDestroyResult(result.destroy);
    }
  });

program
  .command('rotate')
  .description('Rotate a service account key: mint a new one, then disable + delete the old. Dry-run by default.')
  .requiredOption('--project <id>', 'Project the service account lives in')
  .requiredOption('--service-account <email>', 'Service account email whose key(s) to rotate')
  .option('--key-id <id>', 'Rotate only this key id (default: retire all user-managed keys after minting one)')
  .option('--output-dir <dir>', 'Where to write the new key', './credentials')
  .option('--apply', 'Actually mint + retire keys (default is a dry-run)')
  .option('--json', 'Emit the RotateResult as JSON (implies --yes; suppresses progress output)')
  .option('-y, --yes', 'Skip the interactive confirmation (for scripts)')
  .action(async (opts: { project: string; serviceAccount: string; keyId?: string; outputDir: string; apply?: boolean; json?: boolean; yes?: boolean }) => {
    const json = Boolean(opts.json);
    // Dry-run pass first so the user sees exactly which keys will be retired.
    const plan = await rotateServiceAccountKey({
      projectId: opts.project,
      serviceAccountEmail: opts.serviceAccount,
      keyId: opts.keyId,
      outputDir: opts.outputDir,
      apply: false,
      logger: json ? undefined : log,
    });

    if (!opts.apply) {
      if (json) console.log(JSON.stringify(plan, null, 2));
      else console.log('\nDry-run only. Re-run with --apply to rotate.');
      return;
    }
    if (!json && plan.retiredKeyIds.length === 0 && !opts.keyId) {
      console.log('\nNo existing user-managed keys — will mint a new key only.');
    }
    // --json is machine mode: skip the interactive confirmation (like --yes).
    if (!opts.yes && !json) {
      const ok = await confirm({
        message: `This will mint a new key for ${opts.serviceAccount} and PERMANENTLY delete ${plan.retiredKeyIds.length} old key(s). Proceed?`,
        default: false,
      });
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    const result = await rotateServiceAccountKey({
      projectId: opts.project,
      serviceAccountEmail: opts.serviceAccount,
      keyId: opts.keyId,
      outputDir: opts.outputDir,
      apply: true,
      logger: json ? undefined : log,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n✓ Done.');
      if (result.newKeyFile) console.log(`  New key:  ${result.newKeyFile}`);
      if (result.retiredKeyIds.length) console.log(`  Retired:  ${result.retiredKeyIds.join(', ')}`);
      for (const w of result.warnings) console.warn(`  ⚠ ${w}`);
    }
  });

program
  .command('oauth-client')
  .description('Create an OAuth client + consent screen on an existing project (retry for a failed seed --oauth-client).')
  .requiredOption('--project <id>', 'Existing project to add the OAuth client to')
  .requiredOption('--support-email <email>', 'Consent-screen support email')
  .option('--title <title>', 'Consent-screen title (default: the project display name)')
  .option('--output-dir <dir>', 'Where to write client_secret.json', './credentials')
  .option('--json', 'Emit the result as JSON (suppresses progress output)')
  .action(async (opts: { project: string; supportEmail: string; title?: string; outputDir: string; json?: boolean }) => {
    const json = Boolean(opts.json);
    const res = await createProjectOAuthClient({
      projectId: opts.project,
      supportEmail: opts.supportEmail,
      consentScreenTitle: opts.title,
      outputDir: opts.outputDir,
      logger: json ? undefined : log,
    });
    if (json) console.log(JSON.stringify(res, null, 2));
    else console.log(`\n✓ Done. OAuth client: ${res.clientSecretsFile}`);
  });

program
  .command('export')
  .description('Read a project and emit Terraform HCL for its gcp-seeder-managed surface (read-only).')
  .requiredOption('--project <id>', 'Project to export')
  .option('--terraform', 'Emit Terraform HCL (the default and only format today)')
  .option('-o, --output <file>', 'Write HCL to a file instead of stdout')
  .action(async (opts: { project: string; terraform?: boolean; output?: string }) => {
    // When HCL goes to stdout, keep it clean — route progress to stderr.
    const res = await exportProjectTerraform({
      projectId: opts.project,
      logger: opts.output ? log : (m) => console.error(m),
    });
    if (opts.output) {
      await writeFile(opts.output, res.hcl, 'utf8');
      console.log(`✓ Wrote ${opts.output} (${res.counts.services} API(s), ${res.counts.serviceAccounts} SA(s), ${res.counts.wifPools} WIF pool(s)).`);
    } else {
      process.stdout.write(res.hcl);
    }
  });

program
  .command('mcp')
  .description('Run an MCP (stdio) server exposing seed/audit/sweep/destroy/rotate as tools for agents.')
  .action(async () => {
    // stdout is the MCP protocol channel here — never write to it. runMcpServer
    // routes all progress to stderr and blocks until the client disconnects.
    const { runMcpServer } = await import('./mcp.js');
    await runMcpServer();
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
  // Map Google's raw errors (quota, org policy, billing, quota-project, liens…)
  // to a headline + fix. Unknown errors fall through with their original text.
  const explained = explainGoogleError(err);
  if (process.argv.includes('--json')) {
    console.error(JSON.stringify({ error: explained }, null, 2));
  } else if (explained.kind === 'unknown') {
    console.error(`\n✗ ${explained.original}`);
  } else {
    console.error(`\n✗ ${formatExplainedError(explained)}`);
  }
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
  wif?: string;
  billingAccount?: string;
  roles?: string;
  wait?: boolean;
  harden?: boolean;
  budget?: number;
  budgetTopic?: string;
  killSwitch?: boolean;
  skipPreflight?: boolean;
  oauthClient?: boolean;
  supportEmail?: string;
  outputDir: string;
  ttl?: string;
  manifest?: string;
  json?: boolean;
  yes?: boolean;
}

async function run(opts: CliOptions): Promise<void> {
  // --json is a machine mode: it forces non-interactive and suppresses all
  // human output so stdout is a single clean JSON document.
  const json = Boolean(opts.json);
  const interactive = !opts.yes && !json;

  // Preflight: make sure we actually have credentials before doing any work.
  await ensureBootstrap({ interactive, autoInstall: Boolean(opts.yes) || json, logger: json ? () => {} : log });

  // Declarative path: reconcile from a manifest instead of flags/prompts.
  if (opts.manifest) {
    const seedOpts = manifestToSeedOptions(await loadManifest(opts.manifest));
    if (!json) console.log(`\nApplying manifest ${opts.manifest} (reconcile)…`);
    const billingAccount = await resolveBillingForCli(seedOpts.billingAccount ?? opts.billingAccount, seedOpts.apis, interactive, json);
    const result = await seedProject({
      ...seedOpts,
      billingAccount,
      outputDir: seedOpts.outputDir ?? opts.outputDir,
      logger: json ? () => {} : log,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('\n✓ Applied.');
    console.log(`  Project:  ${result.projectId} (${result.projectNumber})`);
    if (result.billingAccount) console.log(`  Billing:  ${result.billingAccount}`);
    console.log(`  APIs:     ${result.enabledApis.length} enabled`);
    if (result.labels.expires) console.log(`  Expires:  ${result.labels.expires}`);
    for (const sa of result.serviceAccounts ?? []) {
      console.log(`  SA:       ${sa.email}${sa.keyFile ? `  (key ${sa.keyFile})` : ''}${sa.roles?.length ? `  roles: ${sa.roles.join(', ')}` : ''}`);
    }
    printHardening(result);
    for (const w of result.warnings) console.warn(`  ⚠ ${w}`);
    printWifGuidance(result);
    printDwdGuidance(result);
    console.log(`\nConsole: https://console.cloud.google.com/home/dashboard?project=${result.projectId}`);
    return;
  }

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

  // Keyless auth needs a service account to bind. If --wif is used without any
  // SA flag/preset, imply a single default SA so the federation has a target.
  const wif = opts.wif ? parseWifTarget(opts.wif) : undefined;
  if (wif && serviceAccounts.length === 0 && !credentials.serviceAccount) {
    credentials = { ...credentials, serviceAccount: true };
  }

  // Roles for the SA(s): explicit --roles wins, else the preset's least-privilege default.
  const roles = opts.roles
    ? validateRoles(opts.roles.split(',').map((r) => r.trim()).filter(Boolean))
    : opts.preset
      ? PRESET_ROLES[opts.preset]
      : undefined;
  // Validate cheap, local inputs BEFORE anything that touches the network.
  if (opts.budget !== undefined && !(Number.isFinite(opts.budget) && opts.budget > 0)) {
    throw new Error('--budget must be a positive number of USD.');
  }
  const billingAccount = await resolveBillingForCli(opts.billingAccount, apis, interactive, json);
  if (opts.budget !== undefined && !billingAccount) throw new Error('--budget needs a linked billing account (pass --billing-account).');
  const budget = opts.budget !== undefined ? { amountUsd: opts.budget, topic: opts.budgetTopic, killSwitch: opts.killSwitch } : undefined;

  // Preflight: catch quota / billing / org-policy / burned-id problems before
  // anything exists. A `fail` stops the run; warn/skip are printed and continue.
  if (!opts.skipPreflight) {
    const report = await preflight({
      projectId,
      parent: opts.parent,
      billingAccount,
      apis,
      wantsServiceAccountKey: credentials.serviceAccount || serviceAccounts.length > 0,
      logger: json ? undefined : undefined,
    });
    if (!json) printPreflightReport(report);
    if (!report.ok) {
      throw new Error('Preflight found blocking problems (see above). Fix them, or pass --skip-preflight to proceed anyway.');
    }
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

  if (!json) {
    console.log('\nReady to seed:');
    console.log(`  project       ${projectId}`);
    console.log(`  apis          ${apis.length ? apis.join(', ') : '(none)'}`);
    console.log(`  service acct  ${saSummary}`);
    if (roles?.length) console.log(`  sa roles      ${roles.join(', ')}`);
    console.log(`  billing       ${billingAccount ?? 'none (project stays unbilled)'}`);
    console.log(`  keyless (wif) ${wif ? `yes (${wif.provider}:${wif.repo})` : 'no'}`);
    console.log(`  oauth client  ${credentials.oauthClient ? 'yes' : 'no'}`);
    console.log(`  harden        ${opts.harden ? 'yes (delete default network, demote default compute SA)' : 'no'}`);
    if (budget) console.log(`  budget        $${budget.amountUsd}${budget.killSwitch ? ' + kill-switch template' : ''}`);
    console.log(`  ttl           ${opts.ttl ?? 'none (no expiry)'}`);
    console.log(`  output dir    ${opts.outputDir}\n`);
  }

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
    wif,
    billingAccount,
    roles: roles?.length ? roles : undefined,
    wait: opts.wait,
    harden: opts.harden,
    budget,
    ttl: opts.ttl,
    supportEmail,
    outputDir: opts.outputDir,
    logger: json ? () => {} : undefined,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('\n✓ Done!');
  console.log(`  Project:  ${result.projectId} (${result.projectNumber})`);
  if (result.billingAccount) console.log(`  Billing:  ${result.billingAccount}`);
  console.log(`  APIs:     ${result.enabledApis.length} enabled`);
  if (result.labels.expires) console.log(`  Expires:  ${result.labels.expires}  (sweep will remove it after this date)`);
  if (result.serviceAccounts?.length) {
    for (const sa of result.serviceAccounts) {
      if (sa.keyFile) console.log(`  SA key:   ${sa.keyFile}  (${sa.email})`);
      else console.log(`  SA:       ${sa.email}  (created, no key — see warnings)`);
      if (sa.roles?.length) console.log(`            roles granted: ${sa.roles.join(', ')}`);
    }
  } else if (result.serviceAccount) {
    console.log(`  SA key:   ${result.serviceAccount.keyFile}`);
  }
  printHardening(result);
  if (result.oauthClient) console.log(`  OAuth:    ${result.oauthClient.clientSecretsFile}`);
  for (const w of result.warnings) console.warn(`  ⚠ ${w}`);

  printWifGuidance(result);
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
/**
 * Print the keyless-CI setup. The provider resource name and SA email are
 * public config (no secrets) — safe to echo and paste straight into a workflow.
 */
function printWifGuidance(result: SeedResult): void {
  if (!result.wif?.length) return;
  console.log('\n🔑 Keyless GitHub Actions auth (Workload Identity Federation) — no key to leak:');
  for (const w of result.wif) {
    console.log(`\n  • ${w.serviceAccountEmail}  (repo ${w.repo})`);
    console.log(`      workload_identity_provider: ${w.providerResourceName}`);
    if (w.workflowSnippetFile) console.log(`      snippet: ${w.workflowSnippetFile}`);
  }
  console.log('\n  Add to your workflow job:  permissions: { id-token: write }');
  console.log('  Then use google-github-actions/auth@v2 with the values above.');
}

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

/** APIs that will not enable on an unbilled project. Used to phrase the "no billing" warning. */
const BILLING_REQUIRED_HINT = /^(aiplatform|run|cloudfunctions|bigquery|storage|pubsub|firestore|compute|speech|texttospeech|vision|translate|generativelanguage)\.googleapis\.com$/;

/**
 * Pick the billing account for a seed run. An explicit id is validated; with
 * none, a single open account is auto-picked, several prompt (interactive) or
 * warn (non-interactive), and zero warns when the requested APIs need billing.
 */
async function resolveBillingForCli(
  requested: string | undefined,
  apis: string[],
  interactive: boolean,
  json: boolean,
): Promise<string | undefined> {
  const auth = await resolveAuth();
  const { account, candidates } = await resolveBillingAccount(auth, requested);
  if (account) return account;
  if (candidates.length > 1 && interactive) {
    return select({
      message: 'Which billing account should this project use?',
      choices: [
        ...candidates.map((c) => ({ name: `${c.displayName}  (${c.name.replace('billingAccounts/', '')})`, value: c.name })),
        { name: 'None — leave the project unbilled', value: '' },
      ],
    }).then((v) => v || undefined);
  }
  const needsBilling = apis.filter((a) => BILLING_REQUIRED_HINT.test(a));
  if (!json && candidates.length > 1) {
    console.warn(`⚠ Several billing accounts found — pass --billing-account <id> to link one. Project will be unbilled.`);
  } else if (!json && needsBilling.length) {
    console.warn(
      `⚠ No billing account is linked; these APIs will likely fail to enable without one: ${needsBilling.join(', ')}. ` +
        'Pass --billing-account <id>.',
    );
  }
  return undefined;
}

function printPreflightReport(r: PreflightReport): void {
  const icon = { pass: '✓', warn: '⚠', fail: '✗', skip: '·' } as const;
  console.log('\nPreflight:');
  for (const c of r.checks) {
    console.log(`  ${icon[c.status]} ${c.id.padEnd(15)} ${c.detail}`);
    if (c.fix && c.status !== 'pass') console.log(`    ${' '.repeat(15)} → ${c.fix}`);
  }
  console.log(r.ok ? '  All blocking checks passed.' : '  Blocking problems found.');
}

function printHardening(result: SeedResult): void {
  const h = result.hardening;
  if (!h) return;
  console.log(
    `  Hardened: default network ${h.defaultNetworkDeleted ? 'deleted' : 'not found'}` +
      ` (${h.firewallRulesDeleted.length} firewall rule(s)); default compute SA editor ${h.defaultComputeSaEditorRemoved ? 'removed' : 'already absent'}`,
  );
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
      const age = k.ageDays !== undefined ? ` · ${k.ageDays}d old` : '';
      console.log(`  • ${k.serviceAccount}`);
      console.log(`      project ${k.projectId} · keyId ${k.keyId}${k.createdAt ? ` · created ${k.createdAt}` : ''}${age}`);
    }
  } else {
    console.log('\n✓ No static (user-managed) service-account keys found.');
  }

  if (r.staleKeys.length) {
    console.log(`\n⏰ Stale keys (${r.staleKeys.length}) past --max-key-age — rotate these:`);
    for (const k of r.staleKeys) {
      console.log(`  • ${k.serviceAccount} · keyId ${k.keyId}${k.ageDays !== undefined ? ` (${k.ageDays}d old)` : ''}`);
      console.log(`      gcp-seeder rotate --project ${k.projectId} --service-account ${k.serviceAccount} --key-id ${k.keyId} --apply`);
    }
  }

  if (r.dwdCheckList.length) {
    console.log('\nDomain-wide delegation — verify these client ids by hand (no API can list DWD):');
    console.log('  Admin console → Security → API controls → Domain-wide delegation');
    for (const d of r.dwdCheckList) {
      console.log(`  • clientId ${d.clientId}  (${d.serviceAccount})`);
    }
  }

  if (r.wifProviders.length) {
    console.log(`\n🔑 Workload Identity Federation providers (${r.wifProviders.length}) — keyless auth:`);
    for (const w of r.wifProviders) {
      console.log(`  • ${w.poolId}/${w.providerId}  (project ${w.projectId})`);
      if (w.issuerUri) console.log(`      issuer:    ${w.issuerUri}`);
      if (w.attributeCondition) console.log(`      condition: ${w.attributeCondition}`);
    }
  }

  if (r.warnings.length) {
    console.log('\nNotes:');
    for (const w of r.warnings) console.log(`  - ${w}`);
  }
  console.log('\nThis was read-only. (Teardown will live in `gcp-seeder destroy`.)');
}

function printSweepResult(r: SweepResult): void {
  console.log(`\nSeeder-owned projects: ${r.scanned}`);
  if (r.scanned === 0) {
    console.log('  (none found — nothing labeled seeded-by=gcp-seeder or matching the fallback globs)');
    return;
  }
  for (const c of r.candidates) {
    const marks = [c.expired ? 'EXPIRED' : '', c.stale ? 'STALE' : ''].filter(Boolean).join(' ');
    const detail = [
      c.expires ? `expires ${c.expires}` : 'no expiry',
      c.ageDays !== undefined ? `age ${c.ageDays}d` : '',
      `owned by ${c.ownedBy}`,
    ]
      .filter(Boolean)
      .join(' · ');
    const flag = c.selected ? `→ SWEEP${marks ? ` (${marks})` : ''}` : 'keep';
    console.log(`  • ${c.projectId}  [${detail}]  ${flag}`);
  }
}

function printDestroyResult(r: DestroyResult): void {
  const did = r.dryRun ? 'would' : 'did';
  const dwd = new Set<string>();
  const empty = (r as { empty?: boolean }).empty === true;
  console.log(`\n${r.dryRun ? 'Plan' : 'Result'}${r.keysOnly ? ' (keys only)' : empty ? ' (empty — project kept)' : ''}:`);
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
    for (const pool of p.wifPoolsDeleted) console.log(`      ${did} delete WIF pool ${pool}`);
    const ext = p as typeof p & { liens?: Array<{ name: string; reason?: string }>; liensRemoved?: string[]; serviceAccountsDeleted?: string[]; budgetDeleted?: boolean; apisDisabled?: string[] };
    for (const l of ext.liens ?? []) console.log(`      lien ${l.name}${l.reason ? ` — ${l.reason}` : ''}${ext.liensRemoved?.includes(l.name) ? ` (${did} remove)` : ''}`);
    for (const sa of ext.serviceAccountsDeleted ?? []) console.log(`      ${did} delete service account ${sa}`);
    if (ext.budgetDeleted) console.log(`      ${did} delete the gcp-seeder budget`);
    if (ext.apisDisabled?.length) console.log(`      ${did} disable ${ext.apisDisabled.length} API(s): ${ext.apisDisabled.join(', ')}`);
    if (!r.keysOnly && !empty) console.log(`      ${did} soft-delete the project`);
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
  logger = log,
}: {
  interactive: boolean;
  autoInstall: boolean;
  /** Progress sink — pass a silent one in --json mode so stdout stays clean JSON. */
  logger?: (m: string) => void;
}): Promise<void> {
  if (hasAdc()) {
    logger('✓ Google Cloud credentials found.');
    return;
  }
  logger("No Google Cloud credentials yet — let's set that up (one-time).\n");

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
    gcloud = await installGcloud(logger);
  }

  await runAdcLogin(gcloud, logger);
}
