# Releasing

Releases are fully automated (GitOps) — no manual `npm version`, no `npm publish`, no tokens.

## How it works

1. Land [Conventional Commits](https://www.conventionalcommits.org) on `dev` (CI runs on every push), then open a PR `dev` → `main` and merge it with a **merge commit**, not a squash, so release-please sees every commit (`feat:` → minor, `fix:` → patch, `feat!:` / `BREAKING CHANGE:` → major).
2. [release-please](https://github.com/googleapis/release-please) keeps an open **Release PR** with the version bump + CHANGELOG.
3. **Squash-merge the Release PR** once `ci` passes. That creates the GitHub release/tag and triggers `.github/workflows/release.yml`, which publishes to npm via **OIDC Trusted Publishing** with a **provenance** attestation.

4. Fast-forward `dev` to `main` so they don't drift: `git checkout dev && git merge --ff-only origin/main && git push`.

Need a specific version? Add a `Release-As: X.Y.Z` footer to a commit.

## One-time setup (per package)

- **Trusted Publisher** — npmjs.com → the package → Settings → Trusted Publisher → GitHub Actions: user `Comradery64`, repo `<pkg>`, workflow `release.yml`, **environment blank**. (This binds npm publishing to this repo's `release.yml` via OIDC — the reason the publish step lives here and not in a shared workflow.)
- **Allow PRs from Actions** — repo Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" (release-please opens the Release PR).

- **Release-bot GitHub App.** `main` requires the `ci` check, but a PR opened with `GITHUB_TOKEN` never triggers workflows, so without the App the Release PR can't merge. `release.yml` mints a short-lived App token when one is configured, and otherwise falls back to `GITHUB_TOKEN`.
  1. Create a GitHub App with no webhook. Repository permissions: **Contents: Read and write** and **Pull requests: Read and write**. Nothing else.
  2. Install it on this repository only.
  3. Generate a private key and pipe it straight into the repo secret, so it never lands in your shell history: `gh secret set RELEASE_APP_PRIVATE_KEY < key.pem`. Then delete the file.
  4. Store the Client ID (not secret) as a repo variable: `gh variable set RELEASE_APP_CLIENT_ID --body <client-id>`.

  Don't use `--admin` merges or relax branch protection to get around the check. The required `ci` check is what keeps an untested build from being released.

## Reusing this for a new tool

The workflows are **self-contained** — no cross-repo reusable dependency. Copy `.github/workflows/ci.yml` and `release.yml` into the new repo and do the one-time setup above. Third-party actions are pinned by full SHA; publishing is tokenless (OIDC) with provenance. Publish never runs from a laptop — local is dev-only.
