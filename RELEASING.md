# Releasing Claude-B

A release publishes `claude-b` to three registries simultaneously from a
single git tag. The workflow is idempotent — re-running it on the same
tag is safe.

## What gets published where

| Target | URL | Consumer install |
|---|---|---|
| npm (public) | https://www.npmjs.com/package/claude-b | `npm i -g claude-b` |
| Docker Hub (public) | https://hub.docker.com/r/danimoya/claude-b | `docker pull danimoya/claude-b` |
| GHCR | https://github.com/danimoya/Claude-B/pkgs/container/claude-b | `docker pull ghcr.io/danimoya/claude-b` |
| GitHub Release | https://github.com/danimoya/Claude-B/releases | tag browser |

Docker images are multi-arch (`linux/amd64`, `linux/arm64`).

## One-time setup

### GitHub secrets

Set on the repo (`Settings → Secrets and variables → Actions`):

| Secret | Source |
|---|---|
| `NPM_TOKEN` | npmjs.com → **Access Tokens** → *Granular* with publish scope on `claude-b` |
| `DOCKERHUB_USERNAME` | `danimoya` |
| `DOCKERHUB_TOKEN` | hub.docker.com → **Account Settings → Security → New Access Token** (R/W/D) — cached in `~/.dockerhub-credentials` |

`GITHUB_TOKEN` is automatic; nothing to set for GHCR.

CLI shortcut:

```bash
gh secret set NPM_TOKEN -b "npm_..."
source ~/.dockerhub-credentials
gh secret set DOCKERHUB_USERNAME -b "$DOCKERHUB_USERNAME"
gh secret set DOCKERHUB_TOKEN    -b "$DOCKERHUB_TOKEN"
```

### DockerHub — first push is private

DockerHub creates any newly-pushed repo as *private* by default. On the
free plan the second private repo hits `plan_exceeded` and anonymous
pulls 404. Flip it to public *once*:

```bash
source ~/.dockerhub-credentials
JWT=$(curl -sS -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$DOCKERHUB_USERNAME\",\"password\":\"$DOCKERHUB_TOKEN\"}" \
  https://hub.docker.com/v2/users/login/ | jq -r .token)

curl -sS -X POST \
  -H "Authorization: JWT $JWT" \
  -H 'Content-Type: application/json' \
  -d '{"is_private":false}' \
  https://hub.docker.com/v2/repositories/danimoya/claude-b/privacy/
```

Note the `/privacy/` sub-path — `PATCH` to the root endpoint returns
200 but silently ignores `is_private`.

## Releasing a new version

```bash
# 1. Make sure main is clean and builds
pnpm build && pnpm typecheck

# 2. Bump version (semver)
npm version patch   # or minor / major — updates package.json + creates a tag

# 3. Push commit + tag
git push origin main --follow-tags
```

`npm version` creates the commit *and* the tag (`vX.Y.Z`). The
`--follow-tags` push triggers `.github/workflows/release.yml`.

Watch it:

```bash
gh run watch --exit-status --workflow=release.yml
```

If only one job fails (usually npm, when a token rolls):

```bash
gh run rerun <run-id> --failed
```

## Verifying a release

```bash
# npm
npm view claude-b dist-tags

# Docker Hub (multi-arch check)
docker manifest inspect danimoya/claude-b:latest | jq '.manifests[] | .platform'

# GHCR
docker pull ghcr.io/danimoya/claude-b:latest

# End-to-end: the landing script
curl -fsSL https://cb.danielmoya.cv | head
```

## Keeping the Docker Hub README in sync

The Hub page's README is *not* pulled from this repo automatically.
Edit `website/DOCKERHUB.md` and push:

```bash
./website/sync-dockerhub-readme.sh
```

The helper PATCHes Hub's `description` and `full_description`. Creds
come from `~/.dockerhub-credentials` unless overridden via env.

## Workflow file reference

`.github/workflows/release.yml` — three jobs, published independently:

- **`npm`** — `npm publish --access public`. Falls back to
  Trusted Publishing (OIDC, `--provenance`) when `NPM_TOKEN` is absent.
- **`docker`** — `docker/build-push-action@v6` with QEMU for arm64.
  Tags: `X.Y.Z`, `X.Y`, `X`, `vX.Y.Z`, `latest`. Pushes to GHCR
  always; to Docker Hub only when `DOCKERHUB_USERNAME` is set.
- **`release`** — `softprops/action-gh-release@v2`. Depends on `docker`
  only, so a broken npm token never blocks the GitHub Release.

A manual dispatch (`workflow_dispatch`) with `dry_run=true` builds
everything and pushes nothing — handy for testing CI edits without a
throwaway tag.

## Upgrading to npm Trusted Publishing (optional)

When you want to retire the long-lived `NPM_TOKEN`:

1. Publish once manually from a laptop with 2FA (`npm publish --otp=...`)
   so the package slot exists on npm.
2. Go to https://www.npmjs.com/package/claude-b/access → *Trusted
   Publishers* → *Add* → **GitHub Actions**. Fill:

   | Field | Value |
   |---|---|
   | Organization or user | `danimoya` |
   | Repository | `Claude-B` |
   | Workflow filename | `release.yml` |
   | Environment name | *(blank)* |

3. Delete `NPM_TOKEN` from the repo secrets. The next release publishes
   with cryptographic provenance and a green "verified" badge on the
   package page.

The workflow is already OIDC-ready (`id-token: write` permission,
`--provenance` when no token is present).

## Credentials & files — where things live

| File / secret | Purpose | Location |
|---|---|---|
| `~/.dockerhub-credentials` | Docker Hub PAT for release + README sync | dev machine, mode 600 |
| `~/.npm-credentials` | Nginx Proxy Manager admin (unrelated to npm) | dev machine, mode 600 |
| `GH secret NPM_TOKEN` | npmjs.com publish auth | repo secrets |
| `GH secret DOCKERHUB_*` | Docker Hub publish auth | repo secrets |
| `.npmrc` | never committed — see `.gitignore` | repo root if created locally |
