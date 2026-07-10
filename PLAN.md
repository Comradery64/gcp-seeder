# gcp-seeder — Expansion Plan (handoff document)

**Written:** 2026-07-08. **For:** a fresh Claude Code session picking this up with zero chat context.
**Repo:** `gcp-seeder` (npm: `gcp-seeder`, v0.3.1, Apache-2.0, author `Comradery64`).

## Why this plan exists

The tool works (create → audit → destroy for GCP projects: APIs, SA keys, DWD guidance, OAuth clients). The owner wants it to be "much more." Agreed direction: **lean into lifecycle, hygiene, and keyless auth** rather than more creation features. Five workstreams below, ordered by value and dependency. Motivating fact from the owner's own environment: their org enforces `iam.disableServiceAccountKeyCreation`, so SA-key minting dead-ends for exactly the orgs that most need this tool — that's why WIF is workstream 1.

## Current state (verified 2026-07-08)

- ~1,700 lines TS across `src/{apis,audit,auth,cli,destroy,gcloud,index,seeder,types}.ts`. Commander.js CLI with `init|seed|audit|destroy`. Google APIs via `googleapis` (cloudresourcemanager v1/v3, iam v1, serviceusage v1, iap v1) over ADC; gcloud is only shelled for install/login.
- `audit` is read-only: orphan-candidate flagging via **glob patterns** (`--flag`, defaults `gyb-project-*`, `seed-*`), user-managed SA key detection, DWD client-id surfacing. Has `--json`.
- `destroy` is dry-run by default, requires `--apply`; refuses projects not matching orphan patterns unless `--force`.
- **No labels are applied to created projects** (`grep -rn labels src/` is empty). No `--json` on `seed`. No WIF, TTL, rotate, or MCP surface.
- Tests: `node:test` (`npm test`), 3 files covering seed/audit/destroy with mocked operations. `npm run typecheck` for types.
- Deeper architecture map: `.frugal-fable/plan/codebase-map.md` (389 lines). **Caveat: it was produced by a cheap agent — treat as leads, not facts.** Known error: it claims `index.ts` is 999 lines; it's 36. Re-verify any specific claim against source before building on it.

## Workstreams (in order)

### WS1 — Workload Identity Federation (`--wif`) — build first

**Goal:** when SA key creation is blocked (or the user opts in), set up keyless auth instead of dead-ending with a warning.

- `seed --wif github:owner/repo` (design for other providers later; GitHub OIDC first): create workload identity pool + OIDC provider, bind the seeded SA with `roles/iam.workloadIdentityUser` scoped to the repo, and print/write a ready-to-paste `google-github-actions/auth` YAML snippet into `--output-dir`.
- When key creation fails on org policy (the existing warn path — see commit `3e8155b`), suggest `--wif` explicitly in the message.
- Extend `audit` to list existing pools/providers per project; extend `destroy` to tear them down.
- New module `src/wif.ts`; wire flags in `cli.ts`; types in `types.ts`; tests mirroring the existing mocked-operation style.
- **Acceptance:** unit tests pass; a real run against a test project produces a working GitHub Actions auth (manual verify — see "org policy" note below); README section "Keyless CI auth (WIF)".

### WS2 — Labels, `sweep`, and TTL (do labels before WS3)

**Goal:** everything the tool creates is findable and mortal.

- On create, label projects `seeded-by=gcp-seeder`, `seeded-at=<ISO date, label-safe format>` (labels have charset limits — lowercase, `[a-z0-9-_]`). Optionally `expires=<date>` when `--ttl <duration>` is passed on seed.
- New `sweep` command: list projects with the `seeded-by` label (fallback to today's glob heuristic for pre-label projects), show age/expiry, and destroy expired/stale ones — reuse `destroy`'s dry-run/`--apply` machinery and safety rails.
- Migrate `audit`/`destroy` orphan detection to prefer labels over globs (keep globs as fallback; don't break existing users).
- **Acceptance:** seeded project carries labels (integration-verifiable via `audit --json`); `sweep` dry-run lists only labeled/expired projects; destroy safety rails still hold.

### WS3 — Audit growth + `rotate`

**Goal:** the command people run monthly even if they never seed again.

- Audit across all visible projects: SA keys older than N days (`--max-key-age`), enabled-but-plausibly-unused APIs, projects with no recent activity. Keep read-only.
- New `rotate` command: mint new key for an SA, write it to output dir, disable-then-delete the old key after confirmation (two-phase, `--apply` gated like destroy).
- **Acceptance:** audit flags a stale key in a fixture/mock; rotate is dry-run safe; docs updated.

### WS4 — `--json` everywhere, then an MCP server

**Goal:** machine-consumable, then agent-consumable.

- Step 1 (prereq): `--json` on `seed`, `destroy`, `sweep`, `rotate` matching `audit`'s pattern (suppress progress logs, emit one structured result). Stable result types exported from the library.
- Step 2: `gcp-seeder mcp` subcommand exposing seed/audit/sweep/destroy as MCP tools (stdio server; use `@modelcontextprotocol/sdk`). Destructive tools must default to dry-run and require an explicit `apply: true` argument. README: "Use with Claude Code / agents".
- **Acceptance:** `--json` output round-trips through `JSON.parse` in tests; MCP server registers in Claude Code and a seed→audit→destroy loop works end-to-end.

### WS5 — Declarative manifest + Terraform export (later; don't start until WS1–3 ship)

- `gcp-seeder.yaml` (name, preset, APIs, SAs, scopes, wif) that `seed` reconciles idempotently; `gcp-seeder export --terraform` emitting HCL for what exists, as the graduation path. Explicitly **not** becoming an IaC tool — scope stops at bootstrap + export.

## Cross-cutting constraints

- **Org policy reality:** the owner's own org blocks SA key creation, so live tests of key paths will fail there — use a personal/test org or mocks; WIF paths *are* testable there. (This is also the sales pitch for WS1.)
- Conventions: conventional commits (`feat:`/`fix:`/`chore:`), release-please drives versioning (see CHANGELOG.md / `.github`), **no AI attribution in commits or PRs**, author identity `Comradery64` + GitHub noreply email only. Never commit credentials or key JSON; `--output-dir` contents must stay gitignored.
- Before any publish: run `/publish-check` and stop before push.
- Each workstream = its own branch/PR-sized unit; keep commits small and focused.

## Suggested execution routing (frugal-fable)

- Decompose/review each WS: Fable/Opus. Bounded, well-specified patches with the existing mocked-test pattern (most of WS2–WS4 step 1): Sonnet at low–medium effort, gate = `npm test` + `npm run typecheck` pass. WS1's IAM/WIF binding logic and WS4's MCP destructive-tool defaults are security-relevant: Opus floor, reviewed diff.
- Scratch/working notes go in `.frugal-fable/` (gitignored).

## First actions for the next session

1. Read this file and skim `.frugal-fable/plan/codebase-map.md` (verify claims against source).
2. Start WS1: read `src/seeder.ts` key-creation path and the `3e8155b` warn behavior, design `src/wif.ts`, then implement behind `--wif`.
