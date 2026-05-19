# Any Proxy

[English](README.md) | **简体中文**

基于 Bun 的轻量代理服务，通过 URL 路径转发目标地址，单进程同时承载 HTTP 与 WebSocket 转发。

## 功能

- 路径携带目标地址，自动转发
- 目标地址可省略协议，默认补 `https://`
- WebSocket 升级自动透传
- 自动跟随 HTTP 重定向
- 支持 IP / CIDR 白名单；HTTP/HTTPS 校验来源 IP，WebSocket 校验双端任一命中
- 提供 systemd 与 Docker 两种部署方式

## 原生安装

```bash
curl -sSL https://raw.githubusercontent.com/tokinx/any-proxy/main/install.sh | bash -s -- --lang=zh-CN
# 安装后再次执行可管理白名单 / 卸载
```

| 操作 | 命令 |
|------|------|
| 服务状态 | `systemctl status any-proxy` |
| 重启服务 | `systemctl restart any-proxy` |
| 查看日志 | `journalctl -u any-proxy -f` |

更多使用细节详见 [docs/install.zh-CN.md](docs/install.zh-CN.md)。

## Docker 部署

```bash
docker run -d \
  --name any-proxy \
  --restart always \
  -p 1080:3000 \
  ghcr.io/tokinx/any-proxy:latest
```

首次启动会自动下载 Bun；如果想在容器重建后复用已下载的运行时，可以挂载 `/opt/bun`。

镜像构建流程详见 [docs/ci.zh-CN.md](docs/ci.zh-CN.md)。

## 参数

通过环境变量配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `3000` |
| `ALLOWLIST` | 逗号分隔的 IP 或 CIDR 白名单，留空表示允许全部 | 空 |
| `WS_QUEUE_LIMIT_BYTES` | 下游 WebSocket 未就绪前允许缓冲的最大字节数 | `1048576` |

`ALLOWLIST` 示例：`192.168.1.10,192.168.0.0/16,10.0.0.0/24`，同时支持 IPv4 与 IPv6。

白名单策略：

- HTTP/HTTPS 仅校验客户端来源 IP。
- WebSocket 只要客户端来源 IP 或下游目标 IP 任一命中白名单，即允许建立连接。

## 使用示例

HTTP：

```bash
curl 'http://127.0.0.1:3000/example.com'                   # 协议可省略，默认 https
curl 'http://127.0.0.1:3000/https://example.com/path?q=1'  # 完整 URL
```

WebSocket：

```js
new WebSocket('ws://127.0.0.1:3000/echo.websocket.events')
```

## License

[MIT](LICENSE)
