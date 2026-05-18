# Any Proxy

基于 Bun 的轻量代理服务，支持 HTTP 转发和 WebSocket 转发，适合快速搭一个“通过路径转发目标地址”的通用代理。

## 特性

- 通过路径传入目标地址，自动转发请求
- 目标地址可省略协议，默认补 `https://`
- 支持 `WebSocket` 升级转发
- 自动跟随重定向
- 同时提供 `systemd` 和 Docker 两种部署方式
- GitHub Actions 可自动构建并发布 GHCR 镜像

## 运行要求

### systemd 部署

- Linux
- `systemd`
- `root` 权限或 `sudo`
- `curl`
- `Bun`

`install.sh` 会在缺失时自动安装 Bun。

### Docker 部署

- Docker Engine 或兼容运行时

## systemd 部署

在仓库根目录执行：

```bash
bash install.sh
```

也支持远程一键安装：

```bash
bash -c "$(curl -sSL https://your-url/install.sh)"
```

如需覆盖默认 `proxy.js` 下载地址：

```bash
PROXY_JS_URL="https://your-url/proxy.js" bash -c "$(curl -sSL https://your-url/install.sh)"
```

安装过程会：

- 检测是否已安装，并提供重新安装、卸载、退出选项
- 检测本机 Bun 版本，仅在落后于官方稳定版时提示升级
- 已安装场景下自动带出现有端口作为默认值
- 将服务安装到 `systemd` 并设置开机自启
- 若本地缺少 `proxy.js`，会自动从仓库远程下载

安装目录：

- 代理脚本：`/opt/any-proxy/proxy.js`
- 服务文件：`/etc/systemd/system/any-proxy.service`

常用命令：

```bash
systemctl status any-proxy
systemctl restart any-proxy
systemctl stop any-proxy
journalctl -u any-proxy -f
```

卸载方式：重新运行 `install.sh`，选择“卸载”。

## Docker 部署

### 直接构建并运行

```bash
docker build -t any-proxy:local .
docker run -d \
  --name any-proxy \
  --restart unless-stopped \
  -e PORT=3000 \
  -p 3000:3000 \
  any-proxy:local
```

### 使用 Compose

```bash
docker compose up -d --build
```

仓库内已提供 [compose.yaml](./compose.yaml)，默认映射 `3000:3000`。

### 使用已发布镜像

工作流会将镜像发布到：

```text
ghcr.io/<owner>/<repo>
```

示例：

```bash
docker run -d \
  --name any-proxy \
  --restart unless-stopped \
  -e PORT=3000 \
  -p 3000:3000 \
  ghcr.io/<owner>/<repo>:latest
```

## 使用示例

HTTP：

```bash
curl 'http://127.0.0.1:3000/example.com'
curl 'http://127.0.0.1:3000/https://example.com/path?q=1'
```

WebSocket：

```js
new WebSocket('ws://127.0.0.1:3000/echo.websocket.events')
```

## 端口配置

运行端口支持以下环境变量，优先级从高到低：

1. `PORT`
2. `BUN_PORT`
3. `NODE_PORT`

未设置时默认使用 `3000`。

## GitHub Actions 镜像构建

仓库已提供 [docker.yml](./.github/workflows/docker.yml)：

- `pull_request`：仅构建镜像，验证 Docker 构建不报错
- 推送到任意分支：执行构建
- 推送到默认分支：构建并发布 `latest`
- 推送 `v*` 标签：构建并发布版本标签

默认发布到 GitHub Container Registry，需要仓库允许 `GITHUB_TOKEN` 写入 packages。
