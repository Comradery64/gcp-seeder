# gcp-seeder v0.5 — bootstrap hardening plan

Written 2026-09-25. Companion routing/spend map: [`ORCHESTRATION.md`](./ORCHESTRATION.md).

## Why

A research pass over GitHub issues (terraform-provider-google, project-factory),
Google's forums/issue tracker, Hacker News, and 2023–2026 blogs ranked the things
people hit when creating GCP projects. gcp-seeder already covers the *least*
complained-about parts (random ids, labels/TTL, WIF locked to a repo, dry-run
teardown). It does nothing about the *most* complained-about ones:

| Rank | Pain point | v0.4 status |
| --- | --- | --- |
| 1 | APIs report enabled but are unusable for minutes | not handled |
| 2 | IAM propagation ("first apply fails, second works") | partial (SA key 404 retry, WIF 403 retry) |
| 4 | Billing link 403s / never linked | **not linked at all** |
| 5 | Project quota exceeded, opaque errors | raw error |
| 6 | Burned project ids (409 forever) | raw error |
| 9 | Default compute SA + default network on every project | not handled |
| 10 | Budgets don't stop spend; no hard cap | not handled |
| 12 | Liens block delete | raw error |
| — | Minted SA has **no project roles** → 403 on first call | not handled |

Confirmed in code (2026-09-25): nothing in `src/` touches the Cloud Billing API;
the only IAM grant in the codebase is the WIF `workloadIdentityUser` binding;
only 409 is mapped in `createProject`.

## Scope decisions

- **In:** the ten features below, integrated into `seed`, `preflight` (new),
  `destroy`, `audit`, the manifest, `export`, the MCP server, and the README.
- **Out (deliberately, matches the README's "bootstrap + export, not an IaC
  engine" line):** state-bucket bootstrap, org landing zones, deploying the
  billing kill-switch for the user (we *write* it; the user deploys it), Bitbucket
  WIF (GitLab only — Bitbucket's audience needs a workspace UUID lookup and is
  deferred).
- **`destroy --empty` is scoped** to "remove the gcp-seeder-managed surface and
  keep the project" (keys, WIF pools, service accounts, budget, disable enabled
  APIs) — *not* a gcp-nuke of arbitrary resources. Keeping the project keeps the
  id, which is the actual complaint.

## Architecture rule for this release

Each feature is a **new module + its own test file** with the exact exported
signature below. Feature modules **must not** edit the shared files:
`src/seeder.ts`, `src/cli.ts`, `src/types.ts`, `src/manifest.ts`, `src/mcp.ts`,
`src/apis.ts`, `README.md`. Wiring into those happens in one serial integration
pass per wave (see ORCHESTRATION.md). This is what lets the modules be built in
parallel without merge conflicts.

Shared primitive that already exists on the branch (wave 0):
`src/iam.ts` — `modifyProjectIamPolicy`, `ensureProjectRoles`, `removeProjectRole`.
All project IAM writes go through it (etag read-modify-write, idempotent).

Conventions every module follows:

- ESM TypeScript, `googleapis` via `google.<api>({ version, auth: auth as never })`.
- Tests use `node:test` + `mock.method(google, '<api>', () => ({...}) as never)`
  exactly like `test/seed.test.ts` / `test/iam.test.ts`. Use
  `mock.timers.enable({ apis: ['setTimeout'] })` to skip poll sleeps. Hermetic:
  never touch real ADC (the preload in `test/setup.ts` makes that fail loudly).
- Every function takes `auth: AuthClient` first and an optional
  `log: (m: string) => void` (default no-op) for progress lines.
- Errors: throw `Error` with a message a human can act on. Do not print. The CLI
  layer (feature G) maps Google errors to explanations.
- No secrets in logs, ever. Billing account ids and project numbers are not secrets.

---

## Wave 1 — independent feature modules (parallel)

### A. Billing — `src/billing.ts`, `test/billing.test.ts`

Why: API-created projects have no billing account, so most non-Workspace APIs
(Cloud Run, Vertex AI, BigQuery…) refuse to enable and the `ai` preset likely
fails. Linking must happen **after create and before enabling APIs**.

```ts
export interface BillingAccountInfo { name: string; displayName: string; open: boolean }
/** All billing accounts the caller can see (cloudbilling v1 billingAccounts.list, paginated). */
export async function listBillingAccounts(auth: AuthClient): Promise<BillingAccountInfo[]>;
/**
 * Decide which account to use. `requested` may be "012345-ABCDEF-678901" or
 * "billingAccounts/012345-ABCDEF-678901"; normalize to the latter and verify it
 * is in the list and open (throw a clear error if not). With no `requested`:
 * exactly one open account → return it; zero → return { account: undefined,
 * candidates: [] }; several → return undefined + the candidates (CLI prompts).
 */
export async function resolveBillingAccount(auth: AuthClient, requested?: string):
  Promise<{ account?: string; candidates: BillingAccountInfo[] }>;
/** projects.updateBillingInfo. Idempotent: if already linked to this account, log + return. */
export async function linkBillingAccount(auth: AuthClient, projectId: string, billingAccount: string, log?): Promise<void>;
/** projects.getBillingInfo → billingAccountName or undefined when unlinked. */
export async function getLinkedBillingAccount(auth: AuthClient, projectId: string): Promise<string | undefined>;
/** billingAccounts.testIamPermissions for `billing.resourceAssociations.create`. Used by preflight. */
export async function canLinkProjects(auth: AuthClient, billingAccount: string): Promise<boolean>;
```

Error mapping inside `linkBillingAccount` (throw with these messages):
- 403 → `Cannot link billing account <id>: you need roles/billing.user ON THE BILLING ACCOUNT itself (an org-level grant is not enough when the account lives outside the org).`
- 400/FAILED_PRECONDITION or message containing "Precondition check failed" →
  `Billing account <id> has hit its projects-per-billing-account quota (default 5). Unlink a project or request an increase: https://console.cloud.google.com/billing/<id>/manage`

Also add `billing_account = "<id>"` to the `google_project` block in `src/export.ts`
(read via `getLinkedBillingAccount`; omit the attribute when unlinked). `export.ts`
is owned by this feature in wave 1.

Integration (wave 2, Fable): `SeedOptions.billingAccount?: string`; `--billing-account <id>`;
manifest key `billingAccount`; seed order becomes create → link billing → enable APIs;
`SeedResult.billingAccount?`; interactive wizard prompts when several candidates;
warning (not failure) when no account is found, naming which requested APIs need billing.

### B. Service-account project roles — `src/roles.ts`, `test/roles.test.ts`

Why: the minted key has no roles, so the first Vertex/Run/BigQuery call 403s.
Least privilege: small explicit lists per preset, never Editor/Owner.

```ts
/** Default roles per preset. Keep minimal; Workspace/DWD presets get none (DWD, not IAM). */
export const PRESET_ROLES: Record<string, string[]> = {
  ai: ['roles/aiplatform.user'],           // Vertex + Gemini API calls
  gmail: [], workspace: [], 'directory-sync': [],
};
/** Validate `roles/...` shape; reject basic roles (owner/editor/viewer) unless allowBasic. */
export function validateRoles(roles: string[], { allowBasic = false } = {}): string[];
/** Grant via ensureProjectRoles; returns the roles actually added (for the result + log). */
export async function grantServiceAccountRoles(auth, projectId, saEmail, roles, log?): Promise<string[]>;
```

Use `ensureProjectRoles` from `src/iam.ts`. `grantServiceAccountRoles` must build the
member as `serviceAccount:<email>`. If a role is rejected by the API as not existing
(400 with "Role ... is not supported" / INVALID_ARGUMENT), throw naming the role.

Integration: `ServiceAccountSpec.roles?: string[]`, `SeedOptions.roles?: string[]`
(applies to every SA); `--roles <csv>`; manifest `roles`; preset default applied when
`--preset` is given and `--roles` omitted; roles granted right after each SA is created;
`SeedResult.serviceAccounts[].roles`; `export.ts` emits `google_project_iam_member`
per (SA, role) — that part is done in integration since export.ts is owned by A.

### C. Readiness polling — `src/readiness.ts`, `test/readiness.test.ts`

Why: the #1 complaint. `batchEnable` returns before the service is usable.

```ts
/** True for the "API has not been used in project … or it is disabled … wait a few minutes" 403. */
export function isApiNotReadyError(err: unknown): boolean;
/** Poll serviceusage services.get until every api is state === 'ENABLED'. */
export async function waitForServicesEnabled(auth, projectId, apis: string[], opts?: { timeoutMs?: number; intervalMs?: number; log? }): Promise<void>;
/**
 * Actively probe known APIs with a cheap read and retry while isApiNotReadyError.
 * Unknown APIs are skipped (not an error). Returns which probes ran and their status.
 */
export async function probeApisReady(auth, projectId, apis: string[], opts?): Promise<Array<{ api: string; status: 'ready' | 'timeout' | 'skipped' }>>;
/** Retry `fn` while isApiNotReadyError (bounded attempts/backoff). Reusable by seeder/wif. */
export async function withApiReadyRetry<T>(fn: () => Promise<T>, opts?: { attempts?: number; intervalMs?: number; log? }): Promise<T>;
```

Probe table (only these; a 200 **or a non-readiness 403** both count as ready):
`iam.googleapis.com` → `iam.projects.serviceAccounts.list`;
`cloudresourcemanager.googleapis.com` → `projects.get`;
`serviceusage.googleapis.com` → `services.list(pageSize:1)`;
`aiplatform.googleapis.com` → `projects.locations.list`? (if not available in googleapis, use `projects.locations.datasets.list` on `us-central1`);
`run.googleapis.com` → `projects.locations.services.list` (us-central1);
`storage.googleapis.com` → `buckets.list(project)`;
`bigquery.googleapis.com` → `datasets.list`;
`pubsub.googleapis.com` → `projects.topics.list`;
`cloudfunctions.googleapis.com` → `projects.locations.functions.list` (v2, us-central1);
`firestore.googleapis.com` → `projects.databases.list`.
Default timeout 120 s per API, interval 5 s, log one line per retry.

Integration: after `enableApis` in seeder: `waitForServicesEnabled` then
`probeApisReady`; wrap SA creation and the first `keys.create` in
`withApiReadyRetry`; `--no-wait` opts out; MCP `seed` tool gets `wait` param.
Remove the "give the binding a minute" README caveat only if verified live.

### D. Preflight — `src/preflight.ts`, `test/preflight.test.ts`

Why: quota, billing permission, org policy and burned-id failures are opaque and
happen *after* resources exist. Check before creating anything. **Read-only.**

```ts
export interface PreflightCheck { id: string; status: 'pass' | 'fail' | 'warn' | 'skip'; detail: string; fix?: string }
export interface PreflightReport { checks: PreflightCheck[]; ok: boolean /* no 'fail' */ }
export interface PreflightOptions {
  projectId?: string; parent?: string; billingAccount?: string; apis?: string[];
  wantsServiceAccountKey?: boolean; auth?: AuthClient; logger?; now?: Date;
}
export async function preflight(options: PreflightOptions): Promise<PreflightReport>;
```

Checks (each independent, each catches its own errors and reports `skip` with the reason when the caller lacks permission):
1. `auth` — ADC resolves; report the principal (email from `oauth2.tokeninfo` or `userinfo`; skip if not obtainable). Never print tokens.
2. `project-id` — if given: valid shape; `projects.search(query: "id:<id>")` over the caller's projects finds it → `fail` "already yours" or `warn` "soft-deleted and counting against quota until <ts>, id can never be reused"; not found → `warn` "not among your projects — Google gives no availability API, a 409 at create means someone else owns it or it was deleted".
3. `quota` — count the caller's projects (ACTIVE + DELETE_REQUESTED) via `projects.search`; `warn` at ≥25 with "default limit is ~30 and soft-deleted projects count; request form: https://support.google.com/code/contact/project_quota_increase". Label as a heuristic.
4. `parent` — if given: `folders|organizations.testIamPermissions(['resourcemanager.projects.create'])`.
5. `billing` — via feature A's `resolveBillingAccount` + `canLinkProjects` (A is on the same wave: **import `./billing.js` and mock it in tests**; if A's file is missing in your worktree, define the two calls against `google.cloudbilling` directly and note it in the report). `fail` when apis include a billing-required service and no linkable account.
6. `org-policy` — on the parent (skip when no parent): orgpolicy v2 `getEffectivePolicy` for `constraints/iam.disableServiceAccountKeyCreation` (`fail` if enforced and `wantsServiceAccountKey`, with the WIF pointer), `constraints/compute.skipDefaultNetworkCreation` (`pass` if enforced: harden step unnecessary), `constraints/iam.automaticIamGrantsForDefaultServiceAccounts`, `constraints/gcp.restrictServiceUsage` (`warn` listing requested APIs when a policy exists).
7. `bootstrap-apis` — the quota project attached to ADC (if any) has `serviceusage` + `cloudresourcemanager` enabled; `skip` when no quota project.

Billing-required set (constant, exported): aiplatform, run, cloudfunctions, bigquery,
storage, pubsub, firestore, compute, speech, texttospeech, vision, translate,
generativelanguage.

Integration: `preflight` CLI command (`--project-id --parent --billing-account --apis --preset --json`),
printed as a pass/fail table; `seed` runs it first and stops on `fail` unless `--skip-preflight`;
MCP tool `gcp_seeder_preflight` (read-only).

### E. Budget + kill-switch template — `src/budget.ts`, `test/budget.test.ts`

Why: "budgets don't stop spend" is a top-10 complaint and the community's most
wanted missing feature. We create the budget and *write* a ready-to-deploy
kill-switch; deploying it is the user's call.

```ts
export interface BudgetSpec { billingAccount: string; projectNumber: string; projectId: string;
  amountUsd: number; currency?: string /* default USD */; thresholds?: number[] /* default [0.5, 0.9, 1.0] */;
  pubsubTopic?: string /* projects/<id>/topics/<name> */ }
export interface BudgetResult { name: string; displayName: string; existed: boolean; pubsubTopic?: string }
/** billingbudgets v1 create, idempotent on displayName `gcp-seeder:<projectId>` (list, then create or reuse). */
export async function ensureBudget(auth, spec: BudgetSpec, log?): Promise<BudgetResult>;
/** Create the Pub/Sub topic if missing (pubsub v1 topics.create, 409 = exists). */
export async function ensureTopic(auth, projectId, topic: string, log?): Promise<string>;
/**
 * Write a deployable kill-switch to <outputDir>/billing-killswitch/: index.js (Cloud Function
 * gen2, Node 20, subscribes to the budget topic, calls cloudbilling projects.updateBillingInfo
 * with billingAccountName "" when costAmount >= budgetAmount), package.json, README.md with
 * the exact `gcloud functions deploy` command and the roles the function SA needs
 * (roles/billing.projectManager on the billing account). Returns the dir.
 */
export async function writeKillSwitchTemplate(outputDir: string, spec: BudgetSpec & { topic: string }): Promise<string>;
```

The budgets API is billed to a quota project: pass `headers: { 'x-goog-user-project': projectId }`
on the calls and require `billingbudgets.googleapis.com` enabled on the seeded project
(integration adds it to the enable list when `--budget` is set). Amount units are a string
of whole units in the API (`units: '50'`).

Integration: `--budget <usd>`, `--budget-topic` (default `gcp-seeder-budget`), `--kill-switch`
(writes template); `SeedOptions.budget?: { amountUsd; thresholds?; topic?; killSwitch? }`;
manifest `budget`; runs after billing link; `SeedResult.budget?`; `destroy` deletes the budget
(feature H knows the displayName convention).

### F. Harden defaults — `src/harden.ts`, `test/harden.test.ts`

Why: every project gets a default VPC with permissive firewall rules and a default
compute SA with Editor. Project-factory does exactly this dance.

```ts
export interface HardenOptions { deleteDefaultNetwork?: boolean /* default true */; demoteDefaultComputeSa?: boolean /* default true */ }
export interface HardenResult { defaultNetworkDeleted: boolean; firewallRulesDeleted: string[]; defaultComputeSaEditorRemoved: boolean; skipped: string[] }
/** Requires compute.googleapis.com enabled. Idempotent: missing network / missing binding → skipped, not an error. */
export async function hardenProjectDefaults(auth, projectId, projectNumber, opts?: HardenOptions, log?): Promise<HardenResult>;
```

- Network: compute v1 `firewalls.list`, delete each rule whose `network` ends with
  `/global/networks/default` (wait each `globalOperations` op), then `networks.delete('default')`
  (wait). 404 anywhere → skipped.
- SA: `removeProjectRole(auth, projectId, 'serviceAccount:<number>-compute@developer.gserviceaccount.com', 'roles/editor')`
  from `src/iam.ts`. **Never delete or disable the default SA** (known trap: unrecoverable after 30 days).
- Also wire `isApiNotReadyError`-style retry locally (compute is often the slowest API to become usable); keep a local copy of the check rather than importing feature C.

Integration: `--harden` on seed (adds `compute.googleapis.com` to the enable list, runs after readiness);
manifest `harden: true`; `SeedResult.hardening?`; `audit` reports whether the default network still exists (integration).

### G. Error explanations — `src/errors.ts`, `test/errors.test.ts`

Why: quota, org-policy, billing, quota-project, and burned-id errors are the top
"what does this even mean" moments. Pure function, easy to test exhaustively.

```ts
export interface ExplainedError { kind: 'quota' | 'org-policy' | 'billing-permission' | 'billing-quota' | 'api-not-ready' | 'quota-project' | 'already-exists' | 'reauth' | 'permission' | 'lien' | 'unknown';
  headline: string; fix?: string; docs?: string; original: string }
export function explainGoogleError(err: unknown, ctx?: { projectId?: string; parent?: string; billingAccount?: string }): ExplainedError;
/** Multi-line, terminal-friendly rendering (no ANSI colors). */
export function formatExplainedError(e: ExplainedError): string;
```

Patterns to map (match on `code` and message, case-insensitive):
- `RESOURCE_EXHAUSTED` / "quota" + "project" → quota: mention default ~30, soft-deleted projects count for 30 days, form URL above.
- "violates constraint" / "orgpolicy" / "constraints/" → org-policy: extract the constraint name; if it is `iam.disableServiceAccountKeyCreation` add the WIF pointer.
- 403 + "billing" → billing-permission (same text as A). "Precondition check failed" + billing → billing-quota.
- "has not been used in project" / "or it is disabled" → api-not-ready: name the project *number* in the message and say whether it matches `ctx.projectId` (if not: "this is your credentials' quota project, not the target").
- `invalid_rapt` / "reauth" → reauth: `gcloud auth application-default login`.
- 409 / "already exists" (with `ctx.projectId`) → already-exists: "project ids are global and never reusable after deletion; pick another or omit --project-id".
- "PROJECT_DELETE_LIEN" / "lien" → lien: point at `destroy --remove-liens`.
- 403 otherwise → permission: include the resource from the message if present.

Integration: CLI top-level catch renders `formatExplainedError`; `--json` mode emits
`{ error: ExplainedError }` on stderr and exits 1; MCP tool errors carry `kind`.

### H. Destroy: liens + `--empty` — edits `src/destroy.ts`, adds `src/liens.ts`, `test/liens.test.ts`, extends `test/destroy.test.ts`

Why: liens block deletion (Shared VPC adds hidden ones), and people want to empty a
project rather than burn its id.

```ts
// src/liens.ts
export interface LienInfo { name: string; origin?: string; reason?: string; restrictions: string[] }
export async function listLiens(auth, projectId): Promise<LienInfo[]>;   // crm v3 liens.list(parent: projects/<id>)
export async function removeLiens(auth, projectId, log?): Promise<string[]>; // delete each, return names
```

In `destroy.ts`: the plan step lists liens per project (`liens: LienInfo[]` on
`DestroyProjectResult`, plus `liensRemoved: string[]`); `apply` with `removeLiens: true`
deletes them before the project delete, otherwise a project with liens is **skipped with
reason** (never fails the whole run). New `empty: true` mode: everything `keysOnly` does,
then delete the user-managed service accounts, delete the budget named
`gcp-seeder:<projectId>` if present (billingbudgets list on the linked account; skip on 403),
and disable every non-bootstrap enabled API (`serviceusage.services.disable` with
`disableDependentServices: true`); keep the project and its labels. `keysOnly` and
`empty` are mutually exclusive.

Integration: `--remove-liens` and `--empty` flags on `destroy`; `sweep` passes
`removeLiens` through; MCP `destroy` gets both params; README.

### I. Scheduled sweep recipes — `examples/sweep-github-actions.yml`, `examples/sweep-cloud-run-job/` (Dockerfile, `deploy.sh`, README.md), `docs/scheduled-sweep.md`

Why: TTL is only useful if something runs `sweep --apply` unattended. Two recipes,
both keyless.

- GitHub Actions: weekly cron, `google-github-actions/auth` with WIF (values from
  `credentials/github-actions-auth.yml`), `npx gcp-seeder sweep --apply --yes --json`,
  upload the JSON as an artifact. Pin actions by full SHA (org rule), `permissions:
  contents: read, id-token: write`.
- Cloud Run Job: image `node:22-slim` + `npm i -g gcp-seeder`, entrypoint
  `gcp-seeder sweep --apply --yes --json`; `deploy.sh` creates a dedicated SA with
  `roles/resourcemanager.projectDeleter` + `roles/iam.serviceAccountKeyAdmin` +
  `roles/iam.workloadIdentityPoolAdmin` on the folder/org (least privilege, documented),
  the job, and a Cloud Scheduler trigger. Every command parameterized by env vars,
  no secrets, no hardcoded ids.
- `docs/scheduled-sweep.md` explains both and the dry-run-first rollout.

Verification: `actionlint` if available, otherwise YAML parses (`node -e` with the `yaml` dep); shell passes `bash -n`.

### J. WIF: GitLab provider + undelete handling — edits `src/wif.ts`, `test/wif.test.ts`; may edit **only** the `WifTarget` interface in `src/types.ts`

Why: same OIDC shape as GitHub; and a deleted pool/provider id is soft-deleted for
30 days and must be `undelete`d, which today surfaces as a confusing 409 reuse.

- `WifTarget.provider: 'github' | 'gitlab'`; `parseWifTarget('gitlab:group/project')`.
- GitLab provider: issuer `https://gitlab.com`, attribute mapping
  `google.subject = assertion.sub`, `attribute.project_path = assertion.project_path`,
  condition `assertion.project_path == '<group/project>'`, pool id `gl-pool`, principal
  `principalSet://iam.googleapis.com/projects/<num>/locations/global/workloadIdentityPools/gl-pool/attribute.project_path/<group/project>`.
  Write `gitlab-ci-auth.yml` snippet: `id_tokens: GITLAB_OIDC_TOKEN: aud: https://iam.googleapis.com/<provider resource>` and the
  `gcloud iam workload-identity-pools create-cred-config` step.
- Rename `setupGithubWif` → `setupWif` taking `target: WifTarget` (keep `setupGithubWif` as a thin alias so the seeder compiles unchanged until integration).
- Undelete: when create 409s, `get` the pool/provider; if `state === 'DELETED'`, call `undelete` and wait the LRO, then continue. Same for providers. Log it.
- `audit` output already prints `issuerUri`; make `listWifPools` label the issuer (`github`/`gitlab`/other) via a small exported `issuerLabel()` so the CLI can show it (CLI change is integration).

Security gate: the attribute condition **must** lock to the exact project path; tests assert the exact condition string and the exact principalSet for both providers.

---

## Wave 2 — integration (serial, Fable)

Order (each step: apply patch → `npm run typecheck && npm test` → commit `feat: …`):

1. G errors (CLI catch + MCP)
2. A billing (types, cli flag + prompt, manifest, seeder order, result, export)
3. C readiness (seeder after enableApis; SA + key retry; `--no-wait`)
4. B roles (types, cli, manifest, preset default, seeder after SA create, export IAM members)
5. E budget (types, cli, manifest, seeder after billing, bootstrap API)
6. F harden (cli, manifest, seeder after readiness, audit default-network line)
7. D preflight (command, seed gate, MCP tool)
8. H destroy (cli flags, sweep passthrough, MCP params)
9. J wif (seeder calls `setupWif`, CLI issuer label, README)
10. I recipes (README links)
11. README: one section per feature from each worker's `README-section.md`; update
    the "What gets created" list and the flag table.

## Wave 3 — verification (parallel)

- Sonnet adversarial verify on the integrated branch for A, B, F, J (the mutating /
  security-relevant ones): reopen the code, try to break idempotency and the IAM
  RMW, confirm tests would catch it (break the guard once, restore).
- Sonnet "documented path" run: every README command parses (`--help` for each
  command, manifest example loads via `loadManifest`, `export` on a mocked project,
  recipes lint).
- Haiku: reduce test/typecheck output and list any `TODO`/`FIXME` left by workers.

## Wave 4 — final review + ship (Fable)

Full diff review at medium effort, `npm run typecheck && npm test`, push the branch.
**No PR, no merge** (branch scope rule). Then the **live smoke checklist** the user
runs with real ADC (nothing here is verified against GCP until this is done):

```bash
npx tsx src/cli.ts preflight --preset ai --billing-account <acct>
npx tsx src/cli.ts --yes --preset ai --service-account --billing-account <acct> --budget 5 --harden --ttl 1d --output-dir /tmp/seed-smoke
# expect: billing linked, roles/aiplatform.user on the SA, default network gone, budget visible in console
npx tsx src/cli.ts audit --project <id>
npx tsx src/cli.ts destroy --project <id> --apply --yes
```

Record what the live run shows (especially whether readiness polling removes the
"wait 1–2 minutes" WIF caveat) in the README before release.

### Live smoke results (2026-09-26, radixark.ai org, it@ credentials)

- **Run 1** failed at the billing link: the chosen account was at the default
  5-projects-per-billing-account cap. Three fixes came out of it (commit
  `49bcf8c`): the top-level error explainer had mislabelled it as the ~30 project
  quota; preflight now counts linked projects and warns at the cap; the seeder
  now says the project exists and how to finish or destroy it. The half-made
  project was removed with `destroy --apply`.
- **Run 2** (`--preset ai --service-account --budget 5 --harden --ttl 1d`,
  org parent, account ending BFEF3C) completed end to end. Verified
  independently via the APIs afterwards: billing linked; 9 APIs enabled;
  `roles/aiplatform.user` bound to the SA and nothing else added; default
  network gone; budget present with 50/90/100 thresholds; labels with a
  1-day expiry. Readiness needed **zero** probe retries. Key creation was
  blocked by `iam.disableServiceAccountKeyCreation` and surfaced as a warning.
  `audit --project` found it; `destroy --apply` soft-deleted it.
- **Still open:** the org-policy preflight check needs a quota project on the
  credentials (`orgpolicy.googleapis.com` refuses plain ADC), so it reports
  `skip` on this org. WIF was not exercised live in this run, so the IAM
  binding-propagation caveat in the README stands.
