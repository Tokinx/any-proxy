# Any Proxy

**English** | [简体中文](README.zh-CN.md)

A lightweight Bun-based proxy that forwards target addresses via URL path. A single process serves both HTTP and WebSocket traffic.

## Features

- Pass the target address in the URL path; the proxy forwards it
- Protocol is optional — defaults to `https://`
- Transparent WebSocket upgrade
- Automatic HTTP redirect following
- IP / CIDR allowlist for HTTP/HTTPS, plus either-peer matching for WebSocket
- Ships with both systemd and Docker deployment options

## Native install (systemd)

```bash
curl -sSL https://raw.githubusercontent.com/tokinx/any-proxy/main/install.sh | bash
# Re-run the same command to manage the allowlist or uninstall
```

| Action | Command |
|--------|---------|
| Service status | `systemctl status any-proxy` |
| Restart service | `systemctl restart any-proxy` |
| View logs | `journalctl -u any-proxy -f` |

See [docs/install.md](docs/install.md) for details.

## Docker

```bash
docker run -d \
  --name any-proxy \
  --restart always \
  -p 1080:3000 \
  ghcr.io/tokinx/any-proxy:latest
```

The first start downloads Bun automatically. Mount `/opt/bun` if you want to reuse the downloaded runtime across container re-creations.

See [docs/ci.md](docs/ci.md) for the image build pipeline.

## Configuration

Configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Listen port | `3000` |
| `ALLOWLIST` | Comma-separated IPs or CIDRs; empty means allow all | empty |
| `WS_QUEUE_LIMIT_BYTES` | Max buffered bytes before downstream WebSocket is ready | `1048576` |

`ALLOWLIST` example: `192.168.1.10,192.168.0.0/16,10.0.0.0/24` (IPv4 and IPv6 both supported).

Allowlist behavior:

- HTTP/HTTPS checks the client source IP only.
- WebSocket allows the connection when either the client source IP or the downstream target IP resolves into the allowlist.

## Examples

HTTP:

```bash
curl 'http://127.0.0.1:3000/example.com'                   # protocol optional, defaults to https
curl 'http://127.0.0.1:3000/https://example.com/path?q=1'  # full URL
```

WebSocket:

```js
new WebSocket('ws://127.0.0.1:3000/echo.websocket.events')
```

## License

[MIT](LICENSE)
