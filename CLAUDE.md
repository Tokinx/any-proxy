# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Any Proxy 是基于 Bun 的单文件 HTTP + WebSocket 反向代理。运行时通过 URL 路径传入下游目标地址，进程内同时承载 HTTP 转发与 WebSocket 升级转发。

核心实现集中在 [proxy.js](proxy.js)，部署侧分两条路径：

- `install.sh`：systemd 一键安装/卸载脚本，包含白名单管理子命令
- `Dockerfile` + `compose.yaml`：容器化部署，GitHub Actions ([.github/workflows/docker.yml](.github/workflows/docker.yml)) 自动构建多架构镜像并发布到 GHCR

## 常用命令

### 本地运行 / 调试

```bash
bun proxy.js                                    # 默认 3000 端口
PORT=8080 bun proxy.js                          # 指定端口
IP_ALLOWLIST="10.0.0.0/24" bun proxy.js         # 启用白名单
```

无 npm 依赖、无构建步骤，改完 `proxy.js` 直接重启即可。

### Docker

```bash
docker build -t any-proxy:local .
docker compose up -d --build
```

### systemd 安装与服务管理

```bash
bash install.sh                       # 交互式安装/重装/卸载/管理白名单
systemctl restart any-proxy           # 生效改动需要重启 systemd 服务
journalctl -u any-proxy -f            # 查看日志
```

`install.sh` 既是首次安装脚本，也是已安装状态下的管理菜单（重装、白名单增删查、卸载）。修改 `proxy.js` 后必须重新运行 `install.sh` 或手动 `cp` 到 `/opt/any-proxy/proxy.js` 再 restart 服务——install.sh 不做差异更新，每次都全量覆盖。

## 架构要点

### 路径解析与协议补全

[proxy.js:168-186](proxy.js#L168-L186) `extractTarget()` 处理三类输入：

1. `/https://example.com/p` — 完整 URL
2. `/example.com/p` — 缺协议，自动补 `https://`
3. `/https:/example.com/p` — 被某些上游规范化掉了一个斜杠，需要还原

`toWsUrl()` 仅在 WebSocket 升级路径上把 `http/https` 映射为 `ws/wss`，已经是 `ws*` 则保留。新增协议或重写规则时，HTTP 路径与 WS 路径要同步考虑。

### WebSocket 升级的关键约束

Bun 要求 `srv.upgrade()` **同步**完成握手，否则客户端会拿到协议错误。因此 [proxy.js:225-267](proxy.js#L225-L267) 采用**双阶段连接**：

1. 同步阶段：调用 `srv.upgrade()`，把 `wsTarget`、客户端期望的子协议、要透传的 headers 全部存到 `ws.data`，并立即 echo 第一个 `sec-websocket-protocol` 给客户端
2. 异步阶段：`websocket.open` 钩子 ([proxy.js:318](proxy.js#L318)) 才真正向下游发起 `new WebSocket(...)`，连接成功前到达的客户端消息进 `ws.data.queue`，`downstream open` 触发后冲刷队列

修改这一段时务必保留以下不变量，否则会出现握手成功但消息丢失/卡死：

- 子协议在 upgrade 阶段就要选定一个返回给客户端，下游若不接受会主动 close（让客户端自己处理）
- 消息队列必须在 `downstream.open` 里**先冲刷再清空**，并发的 `ws.message` 仍可能在此期间到达
- `close` 钩子里要把 1005/1006 经 `safeCloseCode()` 转换，这两个是保留 code 不能直接 `close()`

Bun 的客户端 WebSocket 构造在「同时有 headers 和 protocols」时需要走扩展 options 对象，仅有 protocols 时走标准位置参数 ([proxy.js:326-335](proxy.js#L326-L335))——这是一个 Bun 特有的形态差异。

### Hop-by-hop / WS 头处理

[proxy.js:203-212](proxy.js#L203-L212) `shouldStripHeader()` 在 WS 转发时剥除 `host`、`connection`、`upgrade`、`content-length`、所有 `sec-websocket-*`。HTTP 路径只单独 `delete("host")`（[proxy.js:287](proxy.js#L287)），因为 Bun 的 `fetch` 会自己处理 hop-by-hop。

响应方向 ([proxy.js:298-300](proxy.js#L298-L300)) 必须删除 `content-encoding` 和 `content-length`，否则 `fetch` 已解压的 body 会与原 header 不一致，导致客户端解压失败或长度截断。

### IP 白名单

[proxy.js:19-160](proxy.js#L19-L160) 是自实现的 IPv4/IPv6 + CIDR 解析器，原因是 Bun 没有内置等价物。要点：

- 仅作用于 HTTP/HTTPS，WebSocket 升级**始终放行**（[proxy.js:219-222](proxy.js#L219-L222)）——这是有意设计，文档与 install.sh 提示均明确说明
- 列表为空时全部放行
- 同时支持 `::ffff:1.2.3.4` 形式的 IPv4-mapped IPv6
- systemd 部署下白名单源是 `/etc/any-proxy.allowlist`，install.sh 在生成 service 文件时将其拼成 `IP_ALLOWLIST=` 环境变量；Docker 部署直接传环境变量

### 重定向

HTTP 转发 `redirect: "follow"` ([proxy.js:295](proxy.js#L295))。注释里写明这是为 GitHub Releases 这类多级跳转场景服务的——客户端拿到 302 后不会再走代理，跟随必须发生在代理端。改成 `manual` 之前先考虑这一约束。

## 环境变量

| 变量 | 作用 | 优先级 |
|------|------|--------|
| `PORT` / `BUN_PORT` / `NODE_PORT` | 监听端口，默认 3000 | 从左到右 |
| `IP_ALLOWLIST` / `ALLOWLIST` / `WHITELIST` | 逗号分隔的 IP/CIDR | 任一即可 |

## 修改代码时的注意事项

- 没有 `package.json`，不要引入 npm 依赖——保持「拷一个文件就能跑」是该项目的核心卖点
- 没有测试套件。功能改动需要本地用 `curl` 与 `new WebSocket()` 双路径自测
- `install.sh` 的远程一键安装会通过 `PROXY_JS_URL` 拉取 `proxy.js`，默认地址硬编码为 `tokinx/any-proxy` 仓库的 raw 地址 ([install.sh:14](install.sh#L14))。fork 后若不覆盖此环境变量，远程安装会拉到上游版本而非本地修改
- Dockerfile 的 `EXPOSE 3000` 是文档性质，运行端口由 `PORT` 环境变量决定；改默认端口要同步改 `Dockerfile`、`compose.yaml`、`install.sh` 中的 `DEFAULT_PORT`
