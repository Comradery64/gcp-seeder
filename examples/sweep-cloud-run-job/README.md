# Scheduled sweep — Cloud Run Job + Cloud Scheduler

Runs `gcp-seeder sweep --apply --yes --json` on a weekly Cloud Scheduler cron,
keyless: the job runs as a dedicated service account and Cloud Run's metadata
server hands it credentials — no downloaded key, ever.

## What this deploys

- A dedicated service account `gcp-seeder-sweep@<PROJECT_ID>.iam.gserviceaccount.com`
  with **least-privilege roles granted only on `PARENT`** (a folder or
  organization, never wider):
  - `roles/resourcemanager.projectDeleter` — soft-delete expired projects.
  - `roles/iam.serviceAccountKeyAdmin` — revoke each swept project's own
    static keys before deletion (part of `destroy`'s cleanup).
  - `roles/iam.workloadIdentityPoolAdmin` — tear down each swept project's WIF
    pools/providers (part of `destroy`'s cleanup).
  - `roles/browser` — read-only, lets it list/identify projects under `PARENT`.
- An Artifact Registry repo and a container image built from `Dockerfile`.
- A Cloud Run **Job** (not a service — this runs to completion and exits)
  running that image as the sweep service account.
- A second, narrowly-scoped service account that only has `roles/run.invoker`
  on this one job, used by Cloud Scheduler to trigger it via an OIDC token
  (no key, no shared secret).
- A Cloud Scheduler HTTP job that invokes the Cloud Run Job on `SCHEDULE`.

## Prerequisites

- `gcloud` CLI authenticated as a principal that can create service accounts,
  grant IAM roles on `PARENT`, and use Cloud Build/Artifact Registry/Cloud Run/
  Cloud Scheduler in `PROJECT_ID`.
- `PROJECT_ID` already exists (this recipe does not create the hosting
  project — use `gcp-seeder` itself for that if you want one dedicated to
  running sweeps).

## Deploy

```bash
export PROJECT_ID=my-ops-project
export REGION=us-central1
export PARENT=folders/123456789012   # or organizations/123456789012
export SCHEDULE="0 6 * * 1"          # optional, this is the default

./deploy.sh
```

Every step is idempotent — re-running `deploy.sh` after a partial failure, or
to pick up a new image or schedule, is safe.

## Dry-run first

Before trusting the schedule, execute the job once with the destructive args
overridden to a dry run:

```bash
gcloud run jobs execute gcp-seeder-sweep \
  --project "$PROJECT_ID" --region "$REGION" \
  --args sweep,--json \
  --wait
```

This runs `gcp-seeder sweep --json` (no `--apply`/`--yes`) instead of the
image's default `sweep --apply --yes --json`, so it only lists what a real
run would delete. Read the job's logs (or the exit result) before letting
Cloud Scheduler fire the destructive default on schedule.

## Remove

```bash
gcloud scheduler jobs delete gcp-seeder-sweep --project "$PROJECT_ID" --location "$REGION"
gcloud run jobs delete gcp-seeder-sweep --project "$PROJECT_ID" --region "$REGION"
gcloud iam service-accounts delete "gcp-seeder-sweep-invoker@${PROJECT_ID}.iam.gserviceaccount.com" --project "$PROJECT_ID"

# Remove the sweep SA's grants on PARENT, then delete it:
parent_type="${PARENT%%/*}"
for role in roles/resourcemanager.projectDeleter roles/iam.serviceAccountKeyAdmin roles/iam.workloadIdentityPoolAdmin roles/browser; do
  gcloud "$parent_type" remove-iam-policy-binding "${PARENT#*/}" \
    --member "serviceAccount:gcp-seeder-sweep@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role "$role"
done
gcloud iam service-accounts delete "gcp-seeder-sweep@${PROJECT_ID}.iam.gserviceaccount.com" --project "$PROJECT_ID"

# Optional: also remove the image/repo
gcloud artifacts repositories delete gcp-seeder-sweep --project "$PROJECT_ID" --location "$REGION"
```
