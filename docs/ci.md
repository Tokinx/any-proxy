# Image Build (GitHub Actions)

**English** | [简体中文](ci.zh-CN.md)

Workflow definition: [.github/workflows/docker.yml](../.github/workflows/docker.yml).

## Triggers and publishing

| Event | Behavior |
|-------|----------|
| `pull_request` | Build only (multi-arch), no push; verifies the Dockerfile |
| Push to non-default branch | Build, do not publish |
| Push to default branch | Build and publish, tag `latest` |
| Push a `v*` tag | Build and publish, semver tags |

## Image location

Published to GitHub Container Registry:

```text
ghcr.io/<owner>/<repo>
```

Tag patterns produced:

- `latest` (default branch only)
- `<branch>` / `pr-<n>`
- `<version>` / `<major>.<minor>` (from `v*` tags)
- `sha-<git-sha>`

## Build platforms

`linux/amd64` and `linux/arm64`.

## Permissions

- Workflow declares `permissions: packages: write`.
- Repo must allow `GITHUB_TOKEN` to write to GHCR Packages (Settings → Actions → General → Workflow permissions).
