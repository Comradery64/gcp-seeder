# Running `sweep` on a schedule

A `--ttl` label ([Labels & TTL](../README.md#labels--ttl-everything-the-tool-makes-is-findable-and-mortal))
is only useful if something runs `gcp-seeder sweep --apply` unattended. This
repo ships two ready-to-copy, **keyless** recipes for that — pick whichever
fits where your CI/ops already lives.

Both recipes:

- Never store or download a service-account key. GitHub Actions authenticates
  via [Workload Identity Federation](../README.md#keyless-ci-auth-wif); Cloud
  Run authenticates the job's own service account through the metadata
  server.
- Run a **dry-run first** before ever applying, and gate the destructive
  `--apply` behind an explicit trigger.
- Grant only the roles `sweep`/`destroy` actually need, scoped to the
  narrowest resource that makes sense (a repo's WIF condition; a folder or
  organization, never wider, for the Cloud Run recipe).

## Recipe 1 — GitHub Actions

[`examples/sweep-github-actions.yml`](../examples/sweep-github-actions.yml)

A weekly `cron` workflow (plus `workflow_dispatch` for on-demand runs) that:

1. Authenticates via `google-github-actions/auth` using a WIF provider you
   already set up with `gcp-seeder --wif github:<org>/<repo>` (see
   [Keyless CI auth (WIF)](../README.md#keyless-ci-auth-wif)).
2. Always runs `gcp-seeder sweep --json` (dry-run) first and uploads the
   result as a workflow artifact, so every run — scheduled or manual — leaves
   a record of what would be swept.
3. Only runs `gcp-seeder sweep --apply --yes --json` when triggered by the
   `schedule` event, or by `workflow_dispatch` with `apply: true` explicitly
   set. Its output is uploaded as a separate artifact.

Inputs come from two repo/org Actions **variables** (not secrets — WIF has no
secret to store): `GCP_WIF_PROVIDER` (the pool/provider resource name) and
`GCP_SWEEP_SA` (the service account email). Both are printed by `gcp-seeder
--wif` into `credentials/github-actions-auth.yml`.

All third-party actions are pinned by full commit SHA with a version comment,
matching this repo's [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
convention.

## Recipe 2 — Cloud Run Job + Cloud Scheduler

[`examples/sweep-cloud-run-job/`](../examples/sweep-cloud-run-job/) (`Dockerfile`,
`deploy.sh`, `README.md`)

For teams that already run scheduled workloads on GCP rather than GitHub
Actions. `deploy.sh`:

1. Creates a dedicated service account `gcp-seeder-sweep` and grants it, on
   `PARENT` only (a folder or organization — never account-wide):
   - `roles/resourcemanager.projectDeleter` — the actual work of `sweep`.
   - `roles/iam.serviceAccountKeyAdmin` — lets `destroy` revoke a swept
     project's own static keys.
   - `roles/iam.workloadIdentityPoolAdmin` — lets `destroy` tear down a swept
     project's WIF pools.
   - `roles/browser` — read-only, so `sweep` can enumerate projects under
     `PARENT` to find expired ones.
2. Builds an image (`node:22-slim`, non-root) whose default command is
   `gcp-seeder sweep --apply --yes --json`, and deploys it as a Cloud Run
   **Job** running as that service account.
3. Creates a second, single-purpose service account that can only invoke this
   one job, and a Cloud Scheduler HTTP job that triggers it on `SCHEDULE`
   using an OIDC token from that account (no key, no shared secret).

Every step in `deploy.sh` is idempotent: it describes-then-creates (or
describes-then-updates) each resource, so re-running after a partial failure,
or to pick up a new image or schedule, is safe.

## Dry-run-first rollout (both recipes)

Don't let either recipe fire `--apply` unattended before you've watched it
run once:

- **GitHub Actions**: trigger the workflow manually (`workflow_dispatch`)
  with `apply` left at its default (`false`). Only the dry-run step runs;
  inspect the uploaded `sweep-dry-run` artifact.
- **Cloud Run Job**: execute the job once with the args overridden to a dry
  run, before the scheduler ever fires it for real:

  ```bash
  gcloud run jobs execute gcp-seeder-sweep \
    --project "$PROJECT_ID" --region "$REGION" \
    --args sweep,--json --wait
  ```

Once you've confirmed the dry-run output only lists projects you expect to
be swept, let the schedule run unattended.

## Removing either recipe

- **GitHub Actions**: delete the workflow file from `.github/workflows/`, and
  remove the `GCP_WIF_PROVIDER` / `GCP_SWEEP_SA` repo variables if no other
  workflow uses them. The underlying WIF pool/SA can be torn down with
  `gcp-seeder destroy --keys-only` (or `--apply`) on the project that hosts
  them.
- **Cloud Run Job**: see the "Remove" section in
  [`examples/sweep-cloud-run-job/README.md`](../examples/sweep-cloud-run-job/README.md).
