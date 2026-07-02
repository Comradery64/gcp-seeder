# Releasing

Releases are fully automated (GitOps) — no manual `npm version`, no `npm publish`, no tokens.

## How it works

1. Land [Conventional Commits](https://www.conventionalcommits.org) on `main` (`feat:` → minor, `fix:` → patch, `feat!:` / `BREAKING CHANGE:` → major).
2. [release-please](https://github.com/googleapis/release-please) keeps an open **Release PR** with the version bump + CHANGELOG.
3. **Merge the Release PR.** That creates the GitHub release/tag and triggers `.github/workflows/release.yml`, which publishes to npm via **OIDC Trusted Publishing** with a **provenance** attestation.

Need a specific version? Add a `Release-As: X.Y.Z` footer to a commit.

## One-time setup (per package)

- **Trusted Publisher** — npmjs.com → the package → Settings → Trusted Publisher → GitHub Actions: user `Comradery64`, repo `<pkg>`, workflow `release.yml`, **environment blank**. (This binds npm publishing to this repo's `release.yml` via OIDC — the reason the publish step lives here and not in a shared workflow.)
- **Allow PRs from Actions** — repo Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" (release-please opens the Release PR).

## Reusing this for a new tool

The workflows are **self-contained** — no cross-repo reusable dependency. Copy `.github/workflows/ci.yml` and `release.yml` into the new repo and do the one-time setup above. Third-party actions are pinned by full SHA; publishing is tokenless (OIDC) with provenance. Publish never runs from a laptop — local is dev-only.
