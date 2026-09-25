# gcp-seeder 🌱

**Spin up a fully wired Google Cloud project in one command** — project created, APIs enabled, service-account key minted, OAuth credentials downloaded. No clicking through the Cloud Console. Then `audit` what you've left lying around and `destroy` it when you're done — create, audit, tear down.

A standalone TypeScript library + CLI that reimplements GYB's `create-project` flow — heavily inspired by [GAM-team/got-your-back](https://github.com/GAM-team/got-your-back), generalized beyond Gmail. No GYB code is copied; the approach is reimplemented from scratch. ([Credits](#credits))

```bash
npx gcp-seeder
```

That's it. Answer a few prompts and you get a ready-to-use project + credential files.

---

## Why

Every Google API tutorial starts with the same 20-minute slog: create a project, hunt for the right APIs to enable, configure the OAuth consent screen, create credentials, download the JSON. `gcp-seeder` does all of it programmatically so you can get to the actual building.

## Setup (one-time)

```bash
npx gcp-seeder init
```

That's the whole setup. `init` checks for the gcloud SDK, **installs it for you** (into your home dir, no sudo) if it's missing, then opens a browser once so you can sign in. Your only job is picking your Google account — credentials land locally via Application Default Credentials.

> If you skip `init` and run `seed` directly, the seeder runs this same check first and offers to do it inline — you won't get stuck.

> **No baked-in secrets.** Unlike GYB (which ships its own OAuth client), this tool never embeds a client id/secret. It uses *your* credentials, obtained through gcloud's standard ADC login. If you'd rather not use gcloud at all, set `GCP_SEEDER_OAUTH_CLIENT_ID` / `GCP_SEEDER_OAUTH_CLIENT_SECRET` to your own desktop-app OAuth client and pass that auth client to the library instead.

## CLI

`gcp-seeder` covers the whole project lifecycle: **create → audit → tear down.**

> **Scripting.** Every command takes `--json`, which emits its structured result on stdout and suppresses all progress output — so you can pipe `seed`/`audit`/`sweep`/`destroy`/`rotate` straight into `jq`. On the mutating commands `--json` implies `--yes` (no interactive confirmation) and still honors `--apply` / dry-run.

### Setup — `init`

One-time. Installs the gcloud SDK if missing and signs you in (writes ADC credentials) — see [Setup](#setup-one-time) above. Run it once before the others; they also run this check inline, so you can't get stuck.

```bash
npx gcp-seeder init
```

### Preflight — `preflight`

Quota, billing permission, org policy, and burned project ids all fail *after*
the project (and everything in it) already exists, with error messages that
rarely explain what actually went wrong. `preflight` runs the same checks
`seed` is about to rely on — **read-only, nothing is created or changed** —
and prints a pass/fail table before you commit to anything:

```bash
npx gcp-seeder preflight --preset ai --billing-account 012345-ABCDEF-678901
npx gcp-seeder preflight --project-id my-app --parent folders/123456789 --apis run.googleapis.com
npx gcp-seeder preflight --json   # machine-readable
```

| Check | What it catches |
| --- | --- |
| `auth` | Which principal your credentials resolve to (email only — never a token). |
| `project-id` | Invalid id shape; an id that's already yours; a *soft-deleted* id (still counts against quota for 30 days and can never be reused); an id Google gives no way to check availability for ahead of time. |
| `quota` | A heuristic count of your ACTIVE + soft-deleted projects — warns near the default ~30 project-creation limit. |
| `parent` | Whether you actually hold `resourcemanager.projects.create` on the target folder/org. |
| `billing` | Whether a linkable billing account exists/resolves when any requested API needs one (Cloud Run, Vertex AI, BigQuery, Compute, etc.). |
| `org-policy` | `iam.disableServiceAccountKeyCreation` blocking your planned SA key (points you at `--wif` instead); `compute.skipDefaultNetworkCreation`; `iam.automaticIamGrantsForDefaultServiceAccounts`; `gcp.restrictServiceUsage` restricting the APIs you asked for. |
| `bootstrap-apis` | Whether the quota project behind your own ADC credentials has `serviceusage`/`cloudresourcemanager` enabled (skipped if ADC has no quota project attached). |

Example output:

```
Preflight:
  ✓ auth            Authenticated as you@example.com.
  ✓ project-id      "my-app" is not among your projects — nothing conflicts.
  ✓ quota           4 project(s) counted toward quota (heuristic).
  ✓ parent          Can create projects under folders/123456789.
  ✗ billing         No linkable billing account was found. These requested APIs need billing: run.googleapis.com.
                    → Pass --billing-account <id>, or link/create one at https://console.cloud.google.com/billing
  ⚠ org-policy      gcp.restrictServiceUsage has a policy set — verify it allows: run.googleapis.com.
  · bootstrap-apis  No quota project attached to these credentials.
  Blocking problems found.
```

Every check is independent: if your credentials lack permission for one of
them (e.g. you can't read org policy on the parent, or billing is disabled),
that check reports `skip` with the reason rather than failing the whole run —
a permission gap in one area shouldn't hide a real problem in another.

`seed` runs `preflight` automatically first and refuses to continue if any
check reports `fail` — pass `--skip-preflight` to bypass it (useful in CI once
you've already validated the setup, or if you intentionally want to hit the
raw Google error):

```bash
npx gcp-seeder --yes --preset ai --skip-preflight   # go straight to creation
```

The MCP server exposes the same checks read-only as `gcp_seeder_preflight`.

### Create — `seed`

```bash
# Interactive wizard (recommended first run)
npx gcp-seeder

# Non-interactive
npx gcp-seeder --yes \
  --name "My Gemini App" \
  --preset ai \
  --service-account \
  --output-dir ./credentials

# Pick exact APIs + an OAuth client
npx gcp-seeder --yes \
  --apis gmail.googleapis.com,calendar-json.googleapis.com \
  --oauth-client --support-email you@example.com
```

| Flag | Description |
| --- | --- |
| `-p, --project-id <id>` | Project id (auto-generated if omitted) |
| `-n, --name <name>` | Display name |
| `--parent <resource>` | `organizations/123` or `folders/456` |
| `--apis <list>` | Comma-separated service names |
| `--preset <name>` | `gmail`, `workspace`, `ai`, or `directory-sync` |
| `--service-account` | Create a single default service account + JSON key |
| `--service-accounts <names>` | Create one named SA + key per comma-separated name |
| `--dwd-scopes <csv>` | OAuth scopes to surface for domain-wide delegation on the created SAs |
| `--billing-account <id>` | Billing account to link (auto-detected when you have exactly one open account) |
| `--roles <csv>` | Project IAM roles to grant the created service account(s) (preset default if omitted) |
| `--no-wait` | Skip waiting for enabled APIs to become usable |
| `--harden` | Delete the default network and demote the default compute SA |
| `--budget <usd>` | Create a budget with 50/90/100% alerts on the linked billing account |
| `--budget-topic <name>` | Pub/Sub topic to create/reuse for budget notifications |
| `--kill-switch` | Write (not deploy) a Cloud Function that unlinks billing when the budget is exhausted; implies `--budget-topic` |
| `--skip-preflight` | Skip the read-only preflight checks before creating anything |
| `--oauth-client` | Create an OAuth client + consent screen |
| `--support-email <email>` | Required with `--oauth-client` |
| `--wif <target>` | Keyless CI auth via Workload Identity Federation, e.g. `github:owner/repo` or `gitlab:group/project` |
| `--output-dir <dir>` | Credential output dir (default `./credentials`) |
| `--ttl <duration>` | Stamp an `expires` label so `sweep` cleans it up (e.g. `30d`) |
| `--manifest <file>` | Reconcile from a `gcp-seeder.yaml` manifest (idempotent) |
| `--json` | Emit the `SeedResult` as JSON (implies `--yes`; suppresses progress) |
| `-y, --yes` | Skip all prompts |

### Billing

API-created projects start with **no billing account attached**, so most
non-Workspace APIs (Cloud Run, Vertex AI, BigQuery, Pub/Sub, Cloud Functions,
Firestore, Compute, and others) refuse to enable until one is linked.
`gcp-seeder` links a billing account right after the project is created and
before any APIs are enabled.

```bash
npx gcp-seeder --yes --preset ai --billing-account 012345-ABCDEF-678901
```

`--billing-account` accepts the id with or without the `billingAccounts/`
prefix. If it is omitted:

- exactly one **open** billing account visible to your credentials is linked
  automatically;
- zero open accounts → seeding continues with a warning naming which
  requested APIs need billing;
- more than one open account → you're prompted to pick one.

The linked account (bare id, no prefix) is recorded under the `billingAccount`
key in the seed manifest, so subsequent `--manifest` runs and `export`
recognize it without re-asking.

If linking fails, `gcp-seeder` explains the two errors that account for
nearly all billing-link failures instead of surfacing the raw API error:

- **403 permission denied** — you need `roles/billing.user` granted **on the
  billing account itself**. An org-level IAM grant is not enough when the
  billing account lives outside the project's organization.
- **Precondition check failed / quota exceeded** — the billing account has
  hit its projects-per-billing-account limit (5 by default). Unlink an
  existing project or request a quota increase before retrying.

### Readiness polling

`seed` no longer hands you a project the moment `services.enable` returns.
Google's own docs admit a just-enabled API can 403 with "API has not been
used in project … or it is disabled … wait a few minutes" for up to a couple
of minutes. gcp-seeder now waits for `serviceusage` to report every requested
API as `ENABLED`, then actively probes a known subset (IAM, Cloud Resource
Manager, Service Usage, Vertex AI, Cloud Run, Storage, BigQuery, Pub/Sub,
Cloud Functions, Firestore) with a cheap read and retries while it sees that
specific error. The first service-account and key-creation calls are wrapped
in the same retry so a fresh SA doesn't fail its very first call.

Pass `--no-wait` to skip both the wait and the probe and get the old
fire-and-forget behavior back.

### Service-account roles

A freshly minted service account key has no permissions of its own, so the
first API call (for example Vertex AI) returns 403. `gcp-seeder` grants the
service account a small, explicit list of project roles right after creating
it.

**Least privilege by default.** Each preset gets only the roles it needs.
Basic roles (`roles/owner`, `roles/editor`, `roles/viewer`) are never granted
by default, and they are rejected if you pass them.

| Preset | Default roles |
| --- | --- |
| `ai` | `roles/aiplatform.user` |
| `gmail`, `workspace`, `directory-sync` | none (these use domain-wide delegation, not project IAM) |

Override with `--roles <csv>`:

```bash
npx gcp-seeder --yes --preset ai --roles roles/aiplatform.user,roles/storage.objectViewer
```

- If you pass `--preset` without `--roles`, the preset's default roles are used. If you pass `--roles`, that list replaces the default.
- Accepted forms: predefined roles (`roles/<name>`) and custom roles (`projects/<id>/roles/<name>` or `organizations/<id>/roles/<name>`). Duplicates are removed. If any entry is invalid, the command fails and lists every bad entry.
- The grant is idempotent: running again adds only missing roles and never removes other bindings. Updates use an etag read-modify-write, so a concurrent policy change is never overwritten.
- If Google rejects a role (because it does not exist or is not supported on projects), the error names that role.

The manifest's top-level `roles` key applies to every service account it
creates; a service account entry can also set its own `roles` to override
that. Programmatically, set `ServiceAccountSpec.roles?: string[]` per account,
or `SeedOptions.roles` to apply the same roles to every service account.
The roles actually granted are reported in `SeedResult.serviceAccounts[].roles`.

### Service accounts + domain-wide delegation

Need one or more service accounts intended for **domain-wide delegation** (server-to-server access that impersonates a Workspace user)? Two ways:

```bash
# Convenience preset: enable the Admin SDK + a read-only Directory reader SA
npx gcp-seeder --yes --preset directory-sync --output-dir ./credentials
# → credentials/directory-reader-sa.json

# Or mint any number of named SAs generically, with the scopes you choose
npx gcp-seeder --yes \
  --apis admin.googleapis.com \
  --service-accounts reader,writer \
  --dwd-scopes https://www.googleapis.com/auth/admin.directory.user.readonly
# → credentials/reader-sa.json, credentials/writer-sa.json
```

DWD is the one part Google exposes **no API for** — you can't create the authorization programmatically. So instead of leaving you to research it, the seeder prints each SA's OAuth **client id** and the exact scope list to paste into **Admin console → Security → API controls → Domain-wide delegation**. Two things stay manual by design:

- **The DWD grant itself** — no API exists; the tool turns it into one copy-paste.
- **The impersonated admin/user email** — that's runtime config in your consuming tool, not a provisioning artifact.

`--dwd-scopes` only controls what the seeder *reminds* you to authorize; it grants nothing. Read-only vs. write is entirely up to the scopes you list.

> **Org policy note.** Many hardened Workspace orgs enforce `iam.disableServiceAccountKeyCreation`, which blocks *downloadable* SA keys. DWD-based sync needs a key, so on such orgs the seeder still creates the service account (and reports its client id), but records a **warning** instead of failing — you'll need an org admin to grant a policy exception for the project, then mint the key. The project is left in place so you can finish once the exception lands. **For CI, don't fight the policy — use keyless auth ([WIF](#keyless-ci-auth-workload-identity-federation)) instead.**

### Keyless CI auth (Workload Identity Federation)

For CI you usually don't want a downloadable key at all — keys leak, never
rotate, and are exactly what `iam.disableServiceAccountKeyCreation` blocks.
Instead, federate your CI provider's OIDC tokens directly to the service
account with **Workload Identity Federation**. `--wif` sets this up for the
seeded service account; **GitHub Actions** and **GitLab CI (gitlab.com)** are
supported:

```bash
# Create the project + a service account, and set up keyless GitHub Actions auth for a repo
npx gcp-seeder --yes \
  --apis run.googleapis.com \
  --wif github:my-org/my-repo \
  --output-dir ./credentials

npx gcp-seeder --yes --apis run.googleapis.com --wif gitlab:my-group/my-project
npx gcp-seeder --yes --apis run.googleapis.com --wif gitlab:my-group/subgroup/my-project  # nested groups work
```

For each target, gcp-seeder:

1. creates a workload identity pool (`gh-pool` for GitHub, `gl-pool` for GitLab),
2. creates an OIDC provider trusting the CI issuer (`https://token.actions.githubusercontent.com`
   or `https://gitlab.com`), **locked to exactly one repo or project** by an attribute condition —
   without this condition the provider's shared issuer would let *any* repo or project assume the identity:
   - GitHub: `assertion.repository == 'my-org/my-repo'`
   - GitLab: `assertion.project_path == 'my-group/my-project'`
3. grants that repo's or project's federated principal `roles/iam.workloadIdentityUser` on the
   service account (GitLab: `principalSet://…/workloadIdentityPools/gl-pool/attribute.project_path/my-group/my-project`),
4. writes a ready-to-paste CI snippet to the output directory:
   - `github-actions-auth.yml`: a `google-github-actions/auth@v2` step.
   - `gitlab-ci-auth.yml`: a job fragment that requests an `id_tokens` entry
     (`GITLAB_OIDC_TOKEN`, `aud: https://iam.googleapis.com/<provider resource>`), writes the token
     to a file, runs `gcloud iam workload-identity-pools create-cred-config … --service-account=…
     --credential-source-file=… --output-file=…`, then `gcloud auth login --cred-file=…`. This job
     needs the gcloud CLI.

```yaml
# github-actions-auth.yml
permissions:
  contents: read
  id-token: write   # required — GitHub mints the OIDC token

steps:
  - uses: google-github-actions/auth@v2
    with:
      workload_identity_provider: projects/<NUMBER>/locations/global/workloadIdentityPools/gh-pool/providers/<PROVIDER>
      service_account: <sa>@<project>.iam.gserviceaccount.com
```

No key is written, nothing secret ends up in your repo, and there's nothing to
rotate. `--wif` implies a service account if you didn't ask for one; `sts.googleapis.com`
and `iamcredentials.googleapis.com` are enabled for you. Re-running against the same
project reuses the existing pool/provider. GitLab project paths are validated strictly —
every segment must use GitLab's allowed characters, so you can't end up with a malformed
or overly broad condition.

**Re-runs and deleted pools.** If you deleted a pool or provider (for example with
`destroy`), GCP keeps its id soft-deleted for 30 days and won't let you create it again.
gcp-seeder detects this case (the create returns 409 and the resource's state is
`DELETED`), undeletes it, waits for the operation to finish, logs what it did, and then
continues — you don't get a confusing "already exists" error.

> **Give the binding a minute to propagate.** `seed` now waits for enabled APIs to become
> usable before handing back control (see [Readiness polling](#readiness-polling)), but that
> wait does not cover IAM binding propagation: after `seed --wif` completes, the freshly
> granted `roles/iam.workloadIdentityUser` binding can still take **~1–2 minutes** to
> propagate on Google's side. A CI run triggered immediately afterward can fail with
> `iam.serviceAccounts.getAccessToken` denied / *"Unable to acquire impersonated
> credentials."* — this is confirmed: a live GitHub Actions run right after seeding failed
> with that exact error, and a retry ~90s later succeeded. If a brand-new setup fails this
> way, wait a minute or two (or just re-run the workflow once) before treating it as broken.
> There's nothing the tool can usefully do here — the delay is IAM-side propagation, not
> something the seed step can block on without adding latency to every run.

> Only `github:owner/repo` and `gitlab:group/project` are supported today; Bitbucket is out
> of scope (its audience needs a workspace UUID lookup, not just a static string).

### Budget alerts + kill switch — `--budget`

A budget alone doesn't stop spend — it just emails someone once a threshold is
crossed, by which point the bill is already the bill. `--budget <usd>` creates
a real budget on the linked billing account, scoped to just this project, with
alert thresholds at 50%, 90%, and 100% of the amount:

```bash
npx gcp-seeder --yes --preset ai --billing-account 012345-ABCDEF-678901 --budget 25
```

To also get programmatic notifications (not just email), pass `--budget-topic`
to create/reuse a Pub/Sub topic the budget publishes to on every threshold
crossing:

```bash
npx gcp-seeder --yes --preset ai --billing-account 012345-ABCDEF-678901 \
  --budget 25 --budget-topic gcp-seeder-budget
```

Re-running `seed` against the same project is idempotent — the budget is
looked up by a `gcp-seeder:<projectId>` display name and reused rather than
duplicated.

**Actually stopping spend — `--kill-switch`.** A budget only *alerts*; it never
disables anything by itself. `--kill-switch` writes (does **not** deploy) a
ready-to-go Cloud Function to `<output-dir>/billing-killswitch/`: it subscribes
to the budget's Pub/Sub topic, and once spend reaches the budget amount it
calls Cloud Billing to **unlink billing from the project** — which disables
every billable API the project uses. `--kill-switch` implies `--budget-topic`
if you didn't set one.

```bash
npx gcp-seeder --yes --preset ai --billing-account 012345-ABCDEF-678901 \
  --budget 25 --kill-switch --output-dir ./credentials
```

This writes `index.js`, `package.json`, and a `README.md` with the exact
`gcloud functions deploy` command (Cloud Functions gen2, Node 20, Pub/Sub
trigger) and the IAM role the function's runtime service account needs:
`roles/billing.projectManager` **granted on the billing account itself**, not
the project — that's where `updateBillingInfo`'s unlink permission actually
lives, so a project-level grant (even Owner) silently does not work.

> **This disables the project's services when it fires.** Deploying the kill
> switch is a decision you make on purpose — gcp-seeder never deploys it for
> you, only writes it out for review.

The manifest gains a `budget` key (`amountUsd`, `thresholds?`, `topic?`,
`killSwitch?`); `SeedResult.budget` reports the created/reused budget name and
topic. `destroy` removes the budget (matched by the same `gcp-seeder:<projectId>`
display name) when tearing a project down.

### `--harden`: remove insecure project defaults

Every new Google Cloud project gets two things you rarely want:

- a **`default` VPC network** with permissive firewall rules (`default-allow-ssh`,
  `default-allow-rdp`, `default-allow-icmp`, `default-allow-internal`), and
- the **default compute service account** (`<project-number>-compute@developer.gserviceaccount.com`)
  holding **`roles/editor`** on the project.

`--harden` cleans both up, the same way Terraform's project-factory does:

```bash
npx gcp-seeder --yes --preset ai --harden
```

1. Deletes every firewall rule attached to the `default` network (other networks' rules
   are not touched), then deletes the `default` network itself.
2. Removes `roles/editor` from the default compute service account. The rest of the
   project's IAM policy is kept as it is (etag-safe read-modify-write).

To do this, `--harden` adds `compute.googleapis.com` to the APIs it enables, and waits
until the API is usable (Compute is often the slowest API to come up).

The default service account is **demoted, not deleted or disabled**. A deleted default SA
can't be recovered after 30 days, and Compute Engine, GKE and Cloud Build then break
unless you recreate the project. If you need it, grant it narrower roles yourself.

It is idempotent. On a second run, or against a project where the network or the binding
is already gone, those steps are reported as skipped and nothing fails.

**Alternative for organizations:** set the org policy constraint
`compute.skipDefaultNetworkCreation` on your org or folder, and new projects never get
the default network. (The constraint `iam.automaticIamGrantsForDefaultServiceAccounts`
likewise stops the Editor grant.) `--harden` is for when you can't set org policy, or for
projects that already exist.

### Audit — `audit`

Read-only sweep of every project your credentials can see. Flags orphan projects, finds **every static service-account key** (the main credential risk), surfaces the OAuth client ids whose domain-wide-delegation grants you should check by hand (no API can list DWD), and lists **Workload Identity Federation providers** (keyless-auth) with the issuer + repo condition each one trusts.

```bash
npx gcp-seeder audit                    # human-readable report
npx gcp-seeder audit --json             # machine-readable
npx gcp-seeder audit --project a b      # scope to specific projects
npx gcp-seeder audit --max-key-age 90d  # also flag keys older than 90 days as stale
```

With `--max-key-age`, the report adds a **stale keys** section (a subset of the static keys past that age) and prints the exact `rotate` command for each — turning "which keys are overdue?" into copy-paste.

### Tear down — `destroy`

Tear down projects you no longer need: revoke their static keys, tear down any Workload Identity Federation pools, then soft-delete the project (≈30-day recovery). **Dry-run by default** — it prints the plan and changes nothing until you pass `--apply`, only touches the project ids you name (never wildcards), and refuses projects that don't match an orphan pattern unless you `--force`.

```bash
npx gcp-seeder destroy --project gyb-project-xyz             # dry-run: show the plan
npx gcp-seeder destroy --project gyb-project-xyz --apply     # execute (asks to confirm)
npx gcp-seeder destroy --project gyb-project-xyz --keys-only # revoke standing credentials (keys + WIF pools), keep the project
```

`--keys-only` revokes **all standing credentials** — static keys *and* WIF pools — while keeping the project and its service accounts, since WIF is a live credential path just like a key. Domain-wide-delegation grants can't be removed via any API, so `destroy` reports the client ids for you to delete in the Admin console.

#### Liens — `--remove-liens`

Liens block project deletion outright: `destroy` fails with a cryptic
`PROJECT_DELETE_LIEN` error and nothing is torn down. Shared VPC host
projects, for instance, get one automatically the moment they're attached.

`destroy` lists any liens on a project as part of its plan (shown in both
dry-run and `--apply`), and a project that has liens is **skipped, not
failed** — the run continues on to the rest of your target list:

```bash
npx gcp-seeder destroy --project seed-abc123 --apply
# SKIP seed-abc123 deletion — has 1 lien(s); re-run with --remove-liens
```

Pass `--remove-liens` to actually clear them (liens are deleted before the
project itself, in that order) and let the deletion proceed:

```bash
npx gcp-seeder destroy --project seed-abc123 --apply --remove-liens
```

`--remove-liens` only matters when a project is actually being deleted — it's
a no-op with `--keys-only` or `--empty`, since neither of those deletes the
project. `sweep` accepts `--remove-liens` too and passes it straight through
to the underlying destroy call for every project it selects.

#### Emptying a project instead of deleting it — `--empty`

Project ids are global and burned forever once a project is deleted — even a
soft-deleted one keeps the id reserved for the ~30-day recovery window, and
after that it's gone for good. If you don't actually need the id back, `--empty`
strips a project down to bare metal and keeps it around, so you (or your CI)
can re-seed the same id later instead of minting a new one.

`--empty` does everything `--keys-only` does (revokes every user-managed SA
key, tears down WIF pools) and then additionally:

- deletes every **user-managed** service account (the auto-created default
  compute SA and the App Engine default SA are never touched — deleting the
  default compute SA is unrecoverable after 30 days, so gcp-seeder leaves it
  alone on purpose);
- deletes the `gcp-seeder:<projectId>` budget on the project's linked billing
  account, if one exists;
- disables every enabled API on the project except the bootstrap set
  (`cloudresourcemanager`, `serviceusage`, `iam`, `iamcredentials`, `iap`) and
  the WIF token-exchange APIs (`sts`, `iamcredentials`), so the project stays
  usable for a future `seed` run against the same id.

The project itself, and its labels (`seeded-by`, `seeded-at`, `expires`), are
kept — this is deliberately **not** a general-purpose resource nuke, only the
gcp-seeder-managed surface.

```bash
npx gcp-seeder destroy --project seed-abc123 --empty --apply
```

`--empty` and `--keys-only` are mutually exclusive (`destroy` throws if both
are set). Like every other destroy mode, `--empty` is dry-run by default —
run without `--apply` first to see exactly what would be deleted/disabled.

Every new field lands on `destroy`'s plan/result output per project: `liens`,
`liensRemoved`, `serviceAccountsDeleted`, `budgetDeleted`, `apisDisabled` —
so `--json` output and the MCP `destroy` tool both surface the full plan
before anything is mutated.

### Labels & TTL — everything the tool makes is findable and mortal

Every project `seed` creates is stamped with labels: `seeded-by=gcp-seeder` and `seeded-at=<date>`. Pass `--ttl` to also stamp `expires=<date>`, so the project can be cleaned up automatically once it lapses:

```bash
npx gcp-seeder --yes --preset ai --ttl 7d      # a throwaway that expires in a week
```

`audit` and `destroy` both prefer the `seeded-by` label to decide what's yours (the `gyb-project-*` / `seed-*` globs remain as a fallback for projects created before labels existed), so a project with a custom id is still recognized and safe to target.

### Sweep — `sweep`

The command to run on a schedule even if you never seed again: find every seeder-owned project and delete the expired ones. **Dry-run by default**, and it delegates deletion to `destroy`, so all the same safety rails apply (soft-delete, ownership check).

```bash
npx gcp-seeder sweep                 # dry-run: list owned projects, mark expired ones
npx gcp-seeder sweep --apply         # soft-delete the expired ones (asks to confirm)
npx gcp-seeder sweep --max-age 30d   # also sweep owned projects older than 30 days
```

`--max-age` catches projects with no `expires` label (e.g. seeded before you adopted TTLs) once they exceed the age you give.

#### Run sweep on a schedule

`sweep` only clears expired projects if something runs it unattended. Two
ready-to-copy, keyless recipes: a [GitHub Actions workflow](examples/sweep-github-actions.yml)
(weekly cron, WIF auth, dry-run artifact uploaded before any `--apply` run)
and a [Cloud Run Job + Cloud Scheduler](examples/sweep-cloud-run-job/) setup
(dedicated least-privilege service account, idempotent `deploy.sh`). See
[`docs/scheduled-sweep.md`](docs/scheduled-sweep.md) for the full rollout
walkthrough, the exact roles each recipe grants, and how to dry-run before
trusting the schedule.

### Rotate — `rotate`

Replace a service account's key without a window where it has none: `rotate` mints a fresh key and writes it to `--output-dir` **first**, then retires the old one in two phases — disable, then delete — so a broken new key is caught before the old one is gone. **Dry-run by default.**

```bash
npx gcp-seeder rotate --project my-proj --service-account ci@my-proj.iam.gserviceaccount.com          # dry-run
npx gcp-seeder rotate --project my-proj --service-account ci@my-proj.iam.gserviceaccount.com --apply   # rotate all its keys
npx gcp-seeder rotate --project my-proj --service-account ci@... --key-id KEYID --apply                # just one key
```

By default every existing user-managed key is retired once the new one is minted; pass `--key-id` for a single key. If the org blocks key creation (`iam.disableServiceAccountKeyCreation`), nothing is rotated and it points you at keyless auth (`--wif`) instead.

The mint→disable→delete happy-path is covered by unit tests; the org-policy-blocked path is verified live.

### Errors explained

gcp-seeder maps the Google API errors that come up most while bootstrapping —
quota, org policy, billing permissions/quota, the "API not ready yet" 403 (and
its quota-project-confusion cousin), reauth, burned project ids, and liens —
to a plain-language headline and a concrete fix instead of a raw stack trace.

```
The API isn't usable yet for project 555555 — enabling can take a few minutes to propagate.

Fix: Wait a minute or two and retry. gcp-seeder's readiness polling handles
this automatically during seed; if you're calling the API directly, add a
short retry loop.
Original: PERMISSION_DENIED: Cloud Resource Manager API has not been used in
project 555555 before or it is disabled.
```

Nothing secret-shaped (bearer tokens, private key blocks) is ever echoed back.

### Use with Claude Code / agents — `mcp`

`gcp-seeder mcp` runs a stdio [MCP](https://modelcontextprotocol.io) server that exposes the lifecycle as agent tools: `gcp_seeder_audit`, `gcp_seeder_preflight`, `gcp_seeder_seed`, `gcp_seeder_sweep`, `gcp_seeder_destroy`, `gcp_seeder_rotate`. Register it with any MCP client, e.g. Claude Code:

```bash
claude mcp add gcp-seeder -- npx -y gcp-seeder mcp
```

**Safety model, baked in:** `audit` and `preflight` are read-only; the destructive tools (`sweep`, `destroy`, `rotate`) **default to dry-run** and only mutate when the agent passes `apply: true`, and `destroy` still refuses non-seeder-owned projects unless `force: true`. Every tool is annotated (`readOnlyHint` / `destructiveHint`) so clients can prompt before dangerous calls. Progress goes to stderr, keeping the stdio protocol channel clean.

`gcp_seeder_seed` also takes `roles`, `billingAccount`, `budgetUsd`, `harden`, and `wait` — the same least-privilege roles, billing link, budget alerts, and hardening/readiness controls as the `seed` CLI flags (`wif` accepts `gitlab:group/project` too). `gcp_seeder_destroy` takes `removeLiens` and `empty` alongside `keysOnly` — `empty` removes the seeder-managed surface (keys, WIF, service accounts, budget, non-bootstrap APIs) but keeps the project and its id. `gcp_seeder_sweep` takes `removeLiens` as well.

### Declarative manifest — `--manifest`

Describe the project you want in a `gcp-seeder.yaml` and reconcile it — re-running is **idempotent** (an existing project and its service accounts are reused, not re-created, and no duplicate keys are minted):

```yaml
# gcp-seeder.yaml
projectId: my-app
parent: organizations/123456789
displayName: My App
preset: ai                 # optional; unions with `apis`
apis:
  - run.googleapis.com
billingAccount: 012345-ABCDEF-678901
serviceAccount: true
roles:                      # applies to every service account the manifest creates
  - roles/aiplatform.user
wait: true                  # default; set false for the old fire-and-forget behavior
harden: true                # delete the default network + demote the default compute SA
budget:
  amountUsd: 25
  topic: gcp-seeder-budget   # optional
  killSwitch: false          # optional; writes (doesn't deploy) the kill-switch function
wif: github:my-org/my-repo  # or gitlab:my-group/my-project
ttl: 30d
```

Service accounts declared under `serviceAccounts:` can also set a per-account
`roles` list, which overrides the top-level `roles` for that account.

```bash
npx gcp-seeder --manifest gcp-seeder.yaml          # apply (safe to re-run)
npx gcp-seeder --manifest gcp-seeder.yaml --json   # machine-readable result
```

### Export to Terraform — `export`

Once a project exists, graduate it into your IaC: `export` reads it and prints Terraform HCL for the gcp-seeder-managed surface (project — including its linked `billing_account` if one is set — enabled APIs, user service accounts, WIF pools/providers). **Read-only, emits no secrets.** This is a starting point for managing the project in Terraform — the tool deliberately stops at bootstrap + export rather than becoming an IaC engine. Project role bindings held by those service accounts (what `--roles` granted) are exported as `google_project_iam_member`; budgets are not — bring those into Terraform by hand.

```bash
npx gcp-seeder export --project my-app --terraform            # HCL to stdout
npx gcp-seeder export --project my-app --terraform -o main.tf # ...or to a file
```

## Library

```ts
import { seedProject } from 'gcp-seeder';

const result = await seedProject({
  displayName: 'My App',
  apis: ['gmail.googleapis.com', 'aiplatform.googleapis.com'],
  credentials: { serviceAccount: true, oauthClient: false },
  outputDir: './credentials',
});

console.log(result.projectId, result.serviceAccount?.keyFile);
```

`seedProject` resolves auth via ADC by default, or you can pass your own `auth` client (anything from `google-auth-library`). See [`examples/basic.ts`](./examples/basic.ts).

## What gets created

1. **A new GCP project** with a unique id (polls the create operation to completion).
2. **Billing account linked** (if resolved — see [Billing](#billing)), before any APIs are enabled.
3. **APIs enabled** — your selection plus the bootstrap APIs the tool itself needs (Resource Manager, Service Usage, IAM, IAP) — then gcp-seeder waits for them to become usable (see [Readiness polling](#readiness-polling)).
4. **Service account(s) + keys**, each granted its [least-privilege project roles](#service-account-roles) → `credentials/service-account.json` (or `<name>-sa.json` per named SA), if requested.
5. **Keyless CI auth (WIF)** — a workload identity pool + provider for GitHub or GitLab (if `--wif` is set).
6. **Budget + kill switch** — a budget with 50/90/100% alerts on the linked billing account, and optionally a kill-switch Cloud Function written to disk (if `--budget` is set).
7. **Hardening** — the default network and the default compute SA's `roles/editor` grant are removed (if `--harden` is set).
8. **OAuth client + consent screen** → `credentials/client_secret.json` (if requested).
9. **Ownership labels** on the project — `seeded-by=gcp-seeder`, `seeded-at=<date>`, and `expires=<date>` when `--ttl` is set — so `audit`/`sweep`/`destroy` can find it later.

All credential files are written with `0600` permissions, and the included `.gitignore` keeps them out of version control. **Never commit these files.**

## ⚠️ The OAuth-client caveat (read this)

Google has **no official public API for creating arbitrary OAuth clients.** Like GYB, this tool repurposes the **IAP brands API** as a workaround. In practice:

- ✅ **Works** for **Google Workspace ("Internal") org** projects.
- ❌ **Usually fails** for **personal gmail.com** accounts — Google rejects programmatic consent-screen creation.

When it fails, `seedProject` does **not** throw; it records a warning and gives you a direct console link to finish the consent screen by hand. Service-account keys have no such limitation and work everywhere.

## Cleanup

Use the built-in lifecycle commands — `audit` to find what's lying around, `sweep` to auto-clean expired projects, `destroy` to tear down specific ones (all soft-delete, all dry-run first):

```bash
npx gcp-seeder audit                                     # what exists?
npx gcp-seeder sweep --apply                             # delete everything expired
npx gcp-seeder destroy --project <project-id> --apply    # tear down one project
```

For a one-off manual delete you can still use `gcloud projects delete <project-id>`, but `destroy` also revokes the static keys and reminds you to remove any domain-wide-delegation grants.

## Credits

Heavily inspired by [Got Your Back (GYB)](https://github.com/GAM-team/got-your-back) and [GAM](https://github.com/GAM-team/GAM) by Jay Lee and the GAM-team contributors (Apache-2.0). The project-bootstrap approach — create project, enable APIs, mint a service-account key, and the IAP-brands trick for OAuth clients — originates there; `gcp-seeder` reimplements it in TypeScript. See [`NOTICE`](./NOTICE).
