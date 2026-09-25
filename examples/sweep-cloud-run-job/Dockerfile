# Cloud Run Job image that runs `gcp-seeder sweep --apply` on a schedule.
# Keyless: the job runs as a dedicated service account (see deploy.sh) and
# authenticates to Google APIs via the Cloud Run metadata server — no key
# file, no secret, ever.
FROM node:22-slim

RUN npm i -g gcp-seeder \
    && useradd --no-create-home --shell /usr/sbin/nologin --uid 10001 sweeper

USER sweeper

# Split ENTRYPOINT/CMD (rather than baking the whole command into ENTRYPOINT)
# so a one-off dry run can override just the trailing args, e.g.:
#   gcloud run jobs execute gcp-seeder-sweep --args sweep,--json
# which replaces CMD only, giving `gcp-seeder sweep --json` (no --apply/--yes)
# for that single execution while the scheduled default stays destructive.
ENTRYPOINT ["gcp-seeder"]
CMD ["sweep", "--apply", "--yes", "--json"]
