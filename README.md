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

### Setup — `init`

One-time. Installs the gcloud SDK if missing and signs you in (writes ADC credentials) — see [Setup](#setup-one-time) above. Run it once before the others; they also run this check inline, so you can't get stuck.

```bash
npx gcp-seeder init
```

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
| `--oauth-client` | Create an OAuth client + consent screen |
| `--support-email <email>` | Required with `--oauth-client` |
| `--output-dir <dir>` | Credential output dir (default `./credentials`) |
| `-y, --yes` | Skip all prompts |

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

> **Org policy note.** Many hardened Workspace orgs enforce `iam.disableServiceAccountKeyCreation`, which blocks *downloadable* SA keys. DWD-based sync needs a key, so on such orgs the seeder still creates the service account (and reports its client id), but records a **warning** instead of failing — you'll need an org admin to grant a policy exception for the project, then mint the key. The project is left in place so you can finish once the exception lands. **For CI, don't fight the policy — use keyless auth ([WIF](#keyless-ci-auth-wif)) instead.**

### Keyless CI auth (WIF)

For CI you usually don't want a downloadable key at all — keys leak, never rotate, and are exactly what `iam.disableServiceAccountKeyCreation` blocks. Instead, federate your CI provider's OIDC tokens directly to the service account with **Workload Identity Federation**. Today the seeder wires up **GitHub Actions**:

```bash
# Create the project + a service account, and set up keyless GitHub Actions auth for a repo
npx gcp-seeder --yes \
  --apis run.googleapis.com \
  --wif github:my-org/my-repo \
  --output-dir ./credentials
```

This creates a workload identity pool + an OIDC provider that trusts GitHub's issuer, **locked to the exact repo** (`assertion.repository == 'my-org/my-repo'` — without this condition GitHub's shared issuer would let *any* repo assume the identity), grants the repo's federated principal `roles/iam.workloadIdentityUser` on the SA, and writes a ready-to-paste step to `credentials/github-actions-auth.yml`:

```yaml
permissions:
  contents: read
  id-token: write   # required — GitHub mints the OIDC token

steps:
  - uses: google-github-actions/auth@v2
    with:
      workload_identity_provider: projects/<NUMBER>/locations/global/workloadIdentityPools/gh-pool/providers/<PROVIDER>
      service_account: <sa>@<project>.iam.gserviceaccount.com
```

No key is written, nothing secret ends up in your repo, and there's nothing to rotate. `--wif` implies a service account if you didn't ask for one; enable `sts.googleapis.com` and `iamcredentials.googleapis.com` are handled for you. Re-running against the same project reuses the existing pool/provider.

> Only `github:owner/repo` is supported today; the `provider:` prefix leaves room for other OIDC providers later.

### Audit — `audit`

Read-only sweep of every project your credentials can see. Flags orphan projects, finds **every static service-account key** (the main credential risk), surfaces the OAuth client ids whose domain-wide-delegation grants you should check by hand (no API can list DWD), and lists **Workload Identity Federation providers** (keyless-auth) with the issuer + repo condition each one trusts.

```bash
npx gcp-seeder audit              # human-readable report
npx gcp-seeder audit --json       # machine-readable
npx gcp-seeder audit --project my-proj-a my-proj-b   # scope to specific projects
```

### Tear down — `destroy`

Tear down projects you no longer need: revoke their static keys, tear down any Workload Identity Federation pools, then soft-delete the project (≈30-day recovery). **Dry-run by default** — it prints the plan and changes nothing until you pass `--apply`, only touches the project ids you name (never wildcards), and refuses projects that don't match an orphan pattern unless you `--force`.

```bash
npx gcp-seeder destroy --project gyb-project-xyz             # dry-run: show the plan
npx gcp-seeder destroy --project gyb-project-xyz --apply     # execute (asks to confirm)
npx gcp-seeder destroy --project gyb-project-xyz --keys-only # revoke standing credentials (keys + WIF pools), keep the project
```

`--keys-only` revokes **all standing credentials** — static keys *and* WIF pools — while keeping the project and its service accounts, since WIF is a live credential path just like a key. Domain-wide-delegation grants can't be removed via any API, so `destroy` reports the client ids for you to delete in the Admin console.

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
2. **APIs enabled** — your selection plus the bootstrap APIs the tool itself needs (Resource Manager, Service Usage, IAM, IAP).
3. **Service account + key** → `credentials/service-account.json` (if requested).
4. **OAuth client + consent screen** → `credentials/client_secret.json` (if requested).
5. **Ownership labels** on the project — `seeded-by=gcp-seeder`, `seeded-at=<date>`, and `expires=<date>` when `--ttl` is set — so `audit`/`sweep`/`destroy` can find it later.

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
