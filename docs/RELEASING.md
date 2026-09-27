# Releasing

1. Land work on `dev`. CI runs on every push.
2. Open a PR `dev` → `main` and merge it with a **merge commit**, not a squash, so
   release-please sees each `feat:` / `fix:` commit.
3. release-please opens `chore(main): release X.Y.Z`. Once `ci` passes, squash-merge it.
   That creates the tag and GitHub release, and `release.yml` publishes to npm via
   OIDC trusted publishing with provenance.
4. Fast-forward `dev` to `main` so the two don't drift:
   `git checkout dev && git merge --ff-only origin/main && git push`.

## Release-bot GitHub App (one-time setup)

A PR opened with `GITHUB_TOKEN` doesn't trigger workflows, so without an App the
release PR never gets the `ci` check that `main` requires. `release.yml` uses a
short-lived App token when one is configured, and otherwise falls back to
`GITHUB_TOKEN`.

1. Create a GitHub App (Settings → Developer settings → GitHub Apps) with no webhook.
   Repository permissions: **Contents: Read and write** and **Pull requests: Read and
   write**. Nothing else.
2. Install it on this repository only.
3. Generate a private key. Store it as the repo **secret** `RELEASE_APP_PRIVATE_KEY`,
   piping the file straight in so it never lands in your shell history:
   `gh secret set RELEASE_APP_PRIVATE_KEY < key.pem`. Then delete the file.
4. Store the App's Client ID (not secret) as the repo **variable**
   `RELEASE_APP_CLIENT_ID`: `gh variable set RELEASE_APP_CLIENT_ID --body <client-id>`.

Don't bypass the check with `--admin` merges or by relaxing branch protection. The
required `ci` check is what keeps an untested build from being released.
