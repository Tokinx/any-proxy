# systemd Installation & Management

**English** | [简体中文](install.zh-CN.md)

`install.sh` is both the initial installer and the management menu once installed.

## Install paths

| Purpose | Path |
|---------|------|
| Proxy script | `/opt/any-proxy/proxy.js` |
| systemd unit | `/etc/systemd/system/any-proxy.service` |
| Allowlist file | `/etc/any-proxy.allowlist` |

## Install flow

1. Detect whether Any Proxy is already installed; if so, enter the management menu (reinstall, list/add/remove allowlist entries, uninstall).
2. Detect Bun; install it if missing, prompt for upgrade if older than the latest stable release.
3. Ask for the listen port (defaults to the existing port on reinstall).
4. On first install, optionally configure the HTTP/HTTPS allowlist.
5. Write `proxy.js`, generate the systemd unit, then enable and restart the service.

If `proxy.js` is not present locally, the script downloads it from `PROXY_JS_URL`, which defaults to the upstream repo. For forks, override it:

```bash
PROXY_JS_URL="https://your-host/proxy.js" bash -c "$(curl -sSL https://your-host/install.sh)"
```

## Display language

The installer ships in English; pass `zh-CN` to switch to Chinese. Unknown values fall back to English.

```bash
# CLI flag (the `_` is required as a placeholder for $0 in the curl one-liner)
bash -c "$(curl -sSL .../install.sh)" _ --lang=zh-CN

# Or via environment variable
ANY_PROXY_LANG=zh-CN bash -c "$(curl -sSL .../install.sh)"

# Local file
bash install.sh --lang=zh-CN
```

Priority: `--lang` flag > `ANY_PROXY_LANG` env > default English.

## Allowlist

- Only enforced on HTTP/HTTPS; WebSocket upgrades always bypass it.
- Empty list means allow all.
- Accepts single IPs and CIDRs, e.g. `192.168.1.10`, `192.168.0.0/16`, `10.0.0.0/24`. IPv4 and IPv6 are both supported.
- Entries are stored in `/etc/any-proxy.allowlist`. Re-run `install.sh` to add/remove them interactively.

After modifying the allowlist, you must **re-run `install.sh`** (or restart the service manually) so that systemd reloads the new `ALLOWLIST` environment variable.

## Uninstall

Re-run `install.sh` and pick **Uninstall**. The script will:

- Stop and disable `any-proxy.service`
- Remove `/etc/systemd/system/any-proxy.service`
- Remove `/opt/any-proxy/`
- Remove `/etc/any-proxy.allowlist`
- Run `systemctl daemon-reload`

## Requirements

- Linux with systemd
- root or sudo
- `curl` (used to install Bun and fetch a remote `proxy.js`)
- Bun (auto-installed if missing)
