#!/usr/bin/env bash
# Deploys a Cloud Run Job that runs `gcp-seeder sweep --apply --yes --json`
# on a Cloud Scheduler cron, keyless (the job runs as a dedicated service
# account, not a downloaded key).
#
# Env vars (required unless a default is shown):
#   PROJECT_ID  - GCP project to host the job, scheduler, and build.
#   REGION      - Cloud Run / Scheduler region, e.g. us-central1.
#   PARENT      - the scope gcp-seeder sweeps: folders/<NUMBER> or
#                 organizations/<NUMBER>. Every grant below is scoped to this
#                 resource, never to the whole org unless PARENT is the org.
#   SCHEDULE    - cron for Cloud Scheduler (default: "0 6 * * 1", weekly Monday 06:00).
#
# Every step is idempotent: safe to re-run after a partial failure or to
# pick up a new image/schedule.
#
# No secrets are created or read here. No project or org id is hardcoded —
# everything comes from the env vars above.

set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to the GCP project that will host the job}"
: "${REGION:?Set REGION, e.g. us-central1}"
: "${PARENT:?Set PARENT to folders/<NUMBER> or organizations/<NUMBER> — the scope to sweep}"
SCHEDULE="${SCHEDULE:-0 6 * * 1}"

SA_NAME="gcp-seeder-sweep"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
JOB_NAME="gcp-seeder-sweep"
SCHEDULER_NAME="gcp-seeder-sweep"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/gcp-seeder-sweep/gcp-seeder-sweep:latest"
INVOKER_SA_NAME="gcp-seeder-sweep-invoker"
INVOKER_SA_EMAIL="${INVOKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Project: ${PROJECT_ID}  Region: ${REGION}  Parent: ${PARENT}  Schedule: ${SCHEDULE}"

echo "==> Ensuring required APIs are enabled"
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project "${PROJECT_ID}"

echo "==> Ensuring Artifact Registry repo exists"
if ! gcloud artifacts repositories describe gcp-seeder-sweep \
    --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create gcp-seeder-sweep \
    --project "${PROJECT_ID}" --location "${REGION}" \
    --repository-format docker \
    --description "gcp-seeder scheduled sweep job image"
else
  echo "    already exists"
fi

echo "==> Ensuring dedicated service account (${SA_EMAIL}) exists — this is the job's identity"
if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --project "${PROJECT_ID}" \
    --display-name "gcp-seeder scheduled sweep"
else
  echo "    already exists"
fi

echo "==> Granting least-privilege roles on ${PARENT} (not on the whole org unless PARENT is the org)"
# roles/resourcemanager.projectDeleter — the actual job of `sweep`: soft-delete
#   expired projects under PARENT. Nothing more (cannot create/undelete/modify).
# roles/iam.serviceAccountKeyAdmin — `destroy`/`sweep` revoke each swept
#   project's own static keys before deletion; this lets the sweep SA manage
#   *those* projects' key lifecycles (it does not grant any access to the keys'
#   secret material, only list/delete).
# roles/iam.workloadIdentityPoolAdmin — `sweep` also tears down each swept
#   project's WIF pools/providers (a live credential path, same as a key) as
#   part of `destroy`'s cleanup.
# roles/browser — read-only "see the resource hierarchy" role so `sweep` can
#   list/identify projects under PARENT to decide what's expired; it grants no
#   write access to anything.
for role in \
  roles/resourcemanager.projectDeleter \
  roles/iam.serviceAccountKeyAdmin \
  roles/iam.workloadIdentityPoolAdmin \
  roles/browser \
; do
  parent_type="${PARENT%%/*}" # folders | organizations
  echo "    binding ${role} on ${PARENT}"
  gcloud "${parent_type}" add-iam-policy-binding "${PARENT#*/}" \
    --member "serviceAccount:${SA_EMAIL}" \
    --role "${role}" \
    --condition=None \
    >/dev/null
done

echo "==> Building and pushing the image"
gcloud builds submit "$(dirname "${BASH_SOURCE[0]}")" \
  --project "${PROJECT_ID}" \
  --tag "${IMAGE}"

echo "==> Creating/updating the Cloud Run job"
if gcloud run jobs describe "${JOB_NAME}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
  gcloud run jobs update "${JOB_NAME}" \
    --project "${PROJECT_ID}" --region "${REGION}" \
    --image "${IMAGE}" \
    --service-account "${SA_EMAIL}" \
    --max-retries 0 \
    --task-timeout 900
else
  gcloud run jobs create "${JOB_NAME}" \
    --project "${PROJECT_ID}" --region "${REGION}" \
    --image "${IMAGE}" \
    --service-account "${SA_EMAIL}" \
    --max-retries 0 \
    --task-timeout 900
fi

echo "==> Ensuring a dedicated invoker service account for Cloud Scheduler exists"
if ! gcloud iam service-accounts describe "${INVOKER_SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${INVOKER_SA_NAME}" \
    --project "${PROJECT_ID}" \
    --display-name "Invokes the gcp-seeder sweep Cloud Run job"
else
  echo "    already exists"
fi

echo "==> Granting the invoker SA permission to run just this job (least privilege, project-scoped)"
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
  --project "${PROJECT_ID}" --region "${REGION}" \
  --member "serviceAccount:${INVOKER_SA_EMAIL}" \
  --role roles/run.invoker \
  >/dev/null

RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"

echo "==> Creating/updating the Cloud Scheduler job (OIDC-authenticated, no key)"
if gcloud scheduler jobs describe "${SCHEDULER_NAME}" --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${SCHEDULER_NAME}" \
    --project "${PROJECT_ID}" --location "${REGION}" \
    --schedule "${SCHEDULE}" \
    --uri "${RUN_URI}" \
    --http-method POST \
    --oidc-service-account-email "${INVOKER_SA_EMAIL}" \
    --oidc-token-audience "${RUN_URI}"
else
  gcloud scheduler jobs create http "${SCHEDULER_NAME}" \
    --project "${PROJECT_ID}" --location "${REGION}" \
    --schedule "${SCHEDULE}" \
    --uri "${RUN_URI}" \
    --http-method POST \
    --oidc-service-account-email "${INVOKER_SA_EMAIL}" \
    --oidc-token-audience "${RUN_URI}"
fi

echo "==> Done. Before trusting the schedule, run once manually in dry-run mode:"
echo "    gcloud run jobs execute ${JOB_NAME} --project ${PROJECT_ID} --region ${REGION} --args sweep,--json --wait"
