# 镜像构建（GitHub Actions）

[English](ci.md) | **简体中文**

工作流定义见 [.github/workflows/docker.yml](../.github/workflows/docker.yml)。

## 触发与发布策略

| 事件 | 行为 |
|------|------|
| `pull_request` | 仅构建（多架构），不推送，验证 Dockerfile 可用 |
| 推送到非默认分支 | 构建，不发布 |
| 推送到默认分支 | 构建并发布，打 `latest` 标签 |
| 推送 `v*` 标签 | 构建并发布，打版本号标签（semver） |

## 镜像位置

发布到 GitHub Container Registry：

```text
ghcr.io/<owner>/<repo>
```

支持的 tag 形式：

- `latest`（仅默认分支）
- `<branch>` / `pr-<n>`
- `<version>` / `<major>.<minor>`（来自 `v*` 标签）
- `sha-<git-sha>`

## 构建平台

`linux/amd64` 和 `linux/arm64` 双架构。

## 权限要求

- workflow 内已声明 `permissions: packages: write`
- 仓库需允许 `GITHUB_TOKEN` 写入 GHCR Packages（Settings → Actions → General → Workflow permissions）
