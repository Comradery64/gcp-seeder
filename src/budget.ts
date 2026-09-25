import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import type { AuthClient } from 'google-auth-library';

/** Default alert thresholds: 50%, 90%, 100% of the budget. */
const DEFAULT_THRESHOLDS = [0.5, 0.9, 1.0];

/** Default currency when the caller doesn't specify one. */
const DEFAULT_CURRENCY = 'USD';

export interface BudgetSpec {
  /** "012345-ABCDEF-678901" or "billingAccounts/012345-ABCDEF-678901". */
  billingAccount: string;
  /** Numeric project number (budgetFilter scopes by number, not id). */
  projectNumber: string;
  /** Project id — used to build the idempotency-key display name. */
  projectId: string;
  amountUsd: number;
  /** ISO 4217 currency code. Default "USD". */
  currency?: string;
  /** Alert thresholds as fractions of the budget (0.5 = 50%). Default [0.5, 0.9, 1.0]. */
  thresholds?: number[];
  /** Full Pub/Sub topic resource name: "projects/<id>/topics/<name>". */
  pubsubTopic?: string;
}

export interface BudgetResult {
  /** Full budget resource name: "billingAccounts/<id>/budgets/<budgetId>". */
  name: string;
  displayName: string;
  /** True when an existing budget (matched by displayName) was reused instead of created. */
  existed: boolean;
  pubsubTopic?: string;
}

/** Normalize "012345-ABCDEF-678901" or "billingAccounts/012345-ABCDEF-678901" to the resource form. */
function normalizeBillingAccount(billingAccount: string): string {
  return billingAccount.startsWith('billingAccounts/') ? billingAccount : `billingAccounts/${billingAccount}`;
}

/** The displayName gcp-seeder uses to recognize a budget it created, for idempotent reuse. */
function budgetDisplayName(projectId: string): string {
  return `gcp-seeder:${projectId}`;
}

/**
 * Create (or reuse) a budget scoped to one project, with alert thresholds and
 * an optional Pub/Sub notification topic for the kill-switch to subscribe to.
 *
 * Idempotent on displayName `gcp-seeder:<projectId>`: lists the billing
 * account's budgets first and reuses a match rather than creating a duplicate.
 * Billed to the seeded project's quota (`x-goog-user-project`), so
 * `billingbudgets.googleapis.com` must be enabled there.
 */
export async function ensureBudget(
  auth: AuthClient,
  spec: BudgetSpec,
  log: (m: string) => void = () => {},
): Promise<BudgetResult> {
  const bb = google.billingbudgets({ version: 'v1', auth: auth as never });
  const parent = normalizeBillingAccount(spec.billingAccount);
  const displayName = budgetDisplayName(spec.projectId);
  const headers = { 'x-goog-user-project': spec.projectId };

  let pageToken: string | undefined;
  do {
    const { data } = await bb.billingAccounts.budgets.list({
      parent,
      pageToken,
      headers,
    } as never);
    const found = (data.budgets ?? []).find((b) => b.displayName === displayName);
    if (found?.name) {
      log(`✓ Budget "${displayName}" already exists — reusing it`);
      return {
        name: found.name,
        displayName,
        existed: true,
        pubsubTopic: found.notificationsRule?.pubsubTopic ?? undefined,
      };
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  const thresholds = spec.thresholds ?? DEFAULT_THRESHOLDS;
  const currency = spec.currency ?? DEFAULT_CURRENCY;

  log(`Creating budget "${displayName}" (${currency} ${spec.amountUsd})…`);
  const { data: created } = await bb.billingAccounts.budgets.create({
    parent,
    headers,
    requestBody: {
      displayName,
      budgetFilter: { projects: [`projects/${spec.projectNumber}`] },
      amount: {
        specifiedAmount: {
          currencyCode: currency,
          units: String(Math.floor(spec.amountUsd)),
        },
      },
      thresholdRules: thresholds.map((t) => ({ thresholdPercent: t })),
      ...(spec.pubsubTopic
        ? { notificationsRule: { pubsubTopic: spec.pubsubTopic, schemaVersion: '1.0' } }
        : {}),
    },
  } as never);
  if (!created.name) throw new Error(`Budget creation for ${spec.projectId} did not return a resource name.`);
  log(`✓ Budget "${displayName}" created`);
  return { name: created.name, displayName, existed: false, pubsubTopic: spec.pubsubTopic };
}

/** True when a create call failed because the resource already exists (409). */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 409 || /already exists/i.test(msg);
}

/**
 * Create the Pub/Sub topic budget alerts are published to, if it doesn't
 * already exist. Returns the full topic resource name.
 */
export async function ensureTopic(
  auth: AuthClient,
  projectId: string,
  topic: string,
  log: (m: string) => void = () => {},
): Promise<string> {
  const pubsub = google.pubsub({ version: 'v1', auth: auth as never });
  const name = `projects/${projectId}/topics/${topic}`;
  log(`Creating Pub/Sub topic "${topic}"…`);
  try {
    await pubsub.projects.topics.create({ name });
    log(`✓ Topic "${topic}" created`);
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    log(`  topic "${topic}" already exists — reusing it`);
  }
  return name;
}

const INDEX_JS = `'use strict';

/**
 * Billing kill-switch — Cloud Function (gen2), Node 20, CommonJS.
 *
 * Triggered by a Pub/Sub message on the budget's notification topic (the
 * "programmatic budget notification" format:
 * https://cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications#notification_format).
 * When the reported cost has reached (or passed) the budget amount, this
 * UNLINKS BILLING from the project — which stops spend by disabling every
 * billable API the project uses. This is generated by gcp-seeder but is NOT
 * deployed automatically; deploying it is a deliberate, separate decision.
 *
 * Auth: uses google-auth-library Application Default Credentials — the
 * function's own runtime service account. That SA needs
 * roles/billing.projectManager ON THE BILLING ACCOUNT (see README.md in this
 * directory for why a project-level grant is not enough).
 */

const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');

const PROJECT_ID = process.env.KILLSWITCH_PROJECT_ID || '__PROJECT_ID__';

/**
 * Cloud Functions (gen2) Pub/Sub trigger entry point. cloudEvent.data.message.data
 * is the base64-encoded JSON budget notification.
 */
exports.billingKillSwitch = async (cloudEvent) => {
  const message = cloudEvent?.data?.message;
  if (!message?.data) {
    console.log('No Pub/Sub message data — nothing to do.');
    return;
  }

  const payload = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  const { costAmount, budgetAmount, budgetDisplayName } = payload;

  console.log(
    \`Budget notification for "\${budgetDisplayName}": cost=\${costAmount} budget=\${budgetAmount}\`,
  );

  if (typeof costAmount !== 'number' || typeof budgetAmount !== 'number') {
    console.log('Notification missing cost/budget amounts — ignoring (not a spend alert).');
    return;
  }

  if (costAmount < budgetAmount) {
    console.log('Spend is still under budget — no action.');
    return;
  }

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const authClient = await auth.getClient();
  const cloudbilling = google.cloudbilling({ version: 'v1', auth: authClient });

  const projectName = \`projects/\${PROJECT_ID}\`;

  // Guard against re-running when already unlinked — avoids a redundant write
  // (and the resulting no-op 200 is indistinguishable from success anyway).
  const current = await cloudbilling.projects.getBillingInfo({ name: projectName });
  if (!current.data.billingEnabled) {
    console.log(\`Project \${PROJECT_ID} is already unlinked from billing — nothing to do.\`);
    return;
  }

  console.log(\`Budget exhausted — unlinking billing from \${PROJECT_ID} NOW.\`);
  await cloudbilling.projects.updateBillingInfo({
    name: projectName,
    requestBody: { billingAccountName: '' },
  });
  console.log(\`✓ Billing unlinked from \${PROJECT_ID}. Billable APIs will stop working.\`);
};
`;

function packageJson(): string {
  return (
    JSON.stringify(
      {
        name: 'billing-killswitch',
        private: true,
        version: '1.0.0',
        description: 'gcp-seeder budget kill-switch: unlinks billing when a budget is exhausted.',
        main: 'index.js',
        engines: { node: '>=20' },
        dependencies: {
          'google-auth-library': '^9.15.0',
          googleapis: '^144.0.0',
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function readme(spec: BudgetSpec & { topic: string }): string {
  const region = 'us-central1';
  const fnName = 'billing-killswitch';
  const runtimeSa = `${fnName}-sa@${spec.projectId}.iam.gserviceaccount.com`;
  const billingAccountId = spec.billingAccount.startsWith('billingAccounts/')
    ? spec.billingAccount.slice('billingAccounts/'.length)
    : spec.billingAccount;
  return `# Billing kill-switch

**This function DISABLES BILLING for project \`${spec.projectId}\` when it fires.**
Every billable API in the project (Cloud Run, BigQuery, Vertex AI, Compute, …)
stops working the moment billing is unlinked. This is what "stop the spend"
actually means — there is no softer version. Nothing here re-links billing
automatically; that's a deliberate, human, "yes I want this project back" step.

gcp-seeder **writes** this template. It does **not** deploy it. Review it, then
deploy it yourself if you want the budget to actually cut spend instead of just
alerting.

## What it does

Subscribes to the budget's Pub/Sub notification topic (\`${spec.topic}\`). On each
message it decodes the [budget notification JSON](https://cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications#notification_format);
if \`costAmount >= budgetAmount\` it calls Cloud Billing's
\`projects.updateBillingInfo\` with an empty \`billingAccountName\` for
\`projects/${spec.projectId}\`, which unlinks billing. If billing is already
unlinked it no-ops (checked via \`getBillingInfo\` first) instead of re-running
the unlink call.

## Deploy

Create a dedicated runtime service account first — do not reuse a broader one:

\`\`\`bash
gcloud iam service-accounts create ${fnName}-sa \\
  --project=${spec.projectId} \\
  --display-name="Billing kill-switch runtime SA"
\`\`\`

Grant it the role it needs **on the billing account, not the project**
(see "Why the billing-account grant" below):

\`\`\`bash
gcloud billing accounts add-iam-policy-binding ${billingAccountId} \\
  --member="serviceAccount:${runtimeSa}" \\
  --role="roles/billing.projectManager"
\`\`\`

Deploy the function (gen2, Pub/Sub trigger, Node 20):

\`\`\`bash
gcloud functions deploy ${fnName} \\
  --project=${spec.projectId} \\
  --gen2 \\
  --runtime=nodejs20 \\
  --region=${region} \\
  --source=. \\
  --entry-point=billingKillSwitch \\
  --trigger-topic=${spec.topic} \\
  --run-service-account=${runtimeSa} \\
  --set-env-vars=KILLSWITCH_PROJECT_ID=${spec.projectId} \\
  --no-allow-unauthenticated
\`\`\`

## Why the billing-account grant

\`projects.updateBillingInfo\` unlinking a project is authorized against the
**billing account being unlinked from**, not the project. A project-level role
(even Owner) does not include \`billing.resourceAssociations.delete\` — that
permission is bundled into \`roles/billing.projectManager\` and only takes effect
when granted **on the billing account itself**. Granting it on the project only
would make every deploy step above succeed but every invocation 403 the first
time a budget actually fires — which defeats the entire point of a kill switch.

## Testing without waiting for a real budget alert

Publish a synthetic notification to the same topic:

\`\`\`bash
gcloud pubsub topics publish ${spec.topic} \\
  --project=${spec.projectId} \\
  --message='{"budgetDisplayName":"test","costAmount":10,"budgetAmount":5,"currencyCode":"USD"}'
\`\`\`

Then confirm in the console (Billing → Account management) that
\`${spec.projectId}\` shows as unlinked, and re-link it manually to restore
service.
`;
}

/**
 * Write a ready-to-deploy (but NOT deployed) billing kill-switch Cloud
 * Function into `<outputDir>/billing-killswitch/`: `index.js`, `package.json`,
 * `README.md`. Plain files (mode 0644) — this is non-secret, human-reviewable
 * source, unlike the credential files `seeder.ts` writes with 0600. Returns
 * the directory path.
 */
export async function writeKillSwitchTemplate(
  outputDir: string,
  spec: BudgetSpec & { topic: string },
): Promise<string> {
  const dir = path.join(outputDir, 'billing-killswitch');
  await mkdir(dir, { recursive: true });

  const indexJs = INDEX_JS.replace('__PROJECT_ID__', spec.projectId);

  await writeFile(path.join(dir, 'index.js'), indexJs, { mode: 0o644 });
  await writeFile(path.join(dir, 'package.json'), packageJson(), { mode: 0o644 });
  await writeFile(path.join(dir, 'README.md'), readme(spec), { mode: 0o644 });

  return dir;
}
