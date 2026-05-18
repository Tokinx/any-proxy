#!/usr/bin/env bash
set -euo pipefail

# =============================
#        Any Proxy 安装
# =============================

INSTALL_DIR="/opt/any-proxy"
PROXY_JS="$INSTALL_DIR/proxy.js"
SERVICE_NAME="any-proxy"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
DEFAULT_PORT=3000

# ---- 权限检测 ----
if [[ $EUID -eq 0 ]]; then
    SUDO=""
elif command -v sudo &>/dev/null; then
    SUDO="sudo"
else
    echo "需要 root 权限或 sudo 命令" >&2
    exit 1
fi

# ---- systemd 检测 ----
if ! command -v systemctl &>/dev/null; then
    echo "未检测到 systemctl，脚本仅支持 systemd 系统" >&2
    exit 1
fi

# ---- 交互输入：兼容 curl|bash 场景（从 /dev/tty 读取） ----
ask() {
    local prompt="$1" default="${2:-}" reply
    if [[ -n "$default" ]]; then
        printf '%s [%s]: ' "$prompt" "$default" >&2
    else
        printf '%s: ' "$prompt" >&2
    fi
    if [[ -r /dev/tty ]]; then
        IFS= read -r reply </dev/tty || reply=""
    else
        IFS= read -r reply || reply=""
    fi
    printf '%s' "${reply:-$default}"
}

# ---- 激活可能存在但未在 PATH 中的 Bun ----
load_bun_path() {
    if command -v bun &>/dev/null; then return 0; fi
    local candidate
    for candidate in "${HOME:-/root}/.bun/bin" "/root/.bun/bin"; do
        if [[ -x "$candidate/bun" ]]; then
            export PATH="$candidate:$PATH"
            return 0
        fi
    done
    return 1
}

# ---- 提取当前 proxy.js 的端口配置 ----
detect_existing_port() {
    local file="$1" port=""
    [[ -f "$file" ]] || return 0
    port=$(grep -oE '^[[:space:]]*const[[:space:]]+PORT[[:space:]]*=[[:space:]]*[0-9]+' "$file" 2>/dev/null \
        | head -1 | grep -oE '[0-9]+' || true)

    printf '%s' "$port"
}

echo "============================="
echo "        Any Proxy 安装       "
echo "============================="

# ---- 已安装检测：提示重装/卸载/退出 ----
EXISTING_PORT=""
if [[ -f "$PROXY_JS" ]]; then
    EXISTING_PORT=$(detect_existing_port "$PROXY_JS")
    echo
    echo "检测到 Any Proxy 已安装${EXISTING_PORT:+（当前端口: $EXISTING_PORT）}"
    echo "请选择操作:"
    echo "  1) 重新安装"
    echo "  2) 卸载"
    echo "  *) 退出"
    ACTION=$(ask "请输入选项" "")
    case "$ACTION" in
        1)
            echo "准备重新安装..."
            $SUDO systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
            ;;
        2)
            echo "正在卸载 Any Proxy..."
            $SUDO systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
            $SUDO systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
            $SUDO rm -f "$SERVICE_FILE"
            $SUDO rm -rf "$INSTALL_DIR"
            $SUDO systemctl daemon-reload
            echo "卸载完成"
            exit 0
            ;;
        *)
            echo "退出脚本"
            exit 0
            ;;
    esac
fi

# ---- 1. 检测/安装/升级 Bun ----
load_bun_path || true

if ! command -v bun &>/dev/null; then
    echo "未检测到 Bun"
    INSTALL_BUN=$(ask "是否现在安装 Bun？[Y/n]" "Y")
    if [[ ! "$INSTALL_BUN" =~ ^[Yy]$ ]]; then
        echo "未安装 Bun，无法继续" >&2
        exit 1
    fi
    echo "安装 Bun 依赖..."
    if command -v apt-get &>/dev/null; then
        $SUDO apt-get update -y
        $SUDO apt-get install -y unzip curl tar xz-utils
    fi
    echo "下载安装 Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="${BUN_INSTALL:-${HOME:-/root}/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if ! command -v bun &>/dev/null; then
        echo "Bun 安装失败" >&2
        exit 1
    fi
    echo "Bun 安装完成: $(bun --version)"
else
    BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
    echo "Bun 已安装，当前版本: $BUN_VERSION"
    UPGRADE_BUN=$(ask "是否升级 Bun 到最新版本？[y/N]" "N")
    if [[ "$UPGRADE_BUN" =~ ^[Yy]$ ]]; then
        echo "升级 Bun..."
        bun upgrade || echo "升级失败，继续使用当前版本"
        echo "当前版本: $(bun --version)"
    fi
fi

BUN_PATH=$(command -v bun)
if [[ -z "$BUN_PATH" ]]; then
    echo "无法定位 Bun 路径" >&2
    exit 1
fi
echo "Bun 路径: $BUN_PATH"

# ---- 2. 端口配置（已装则沿用，未装则默认 3000） ----
PORT_DEFAULT="${EXISTING_PORT:-$DEFAULT_PORT}"
while :; do
    PORT=$(ask "请输入 Any Proxy 运行端口号" "$PORT_DEFAULT")
    if [[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )); then
        break
    fi
    echo "端口无效（应为 1~65535 的整数），请重新输入"
done
echo "使用端口: $PORT"

# ---- 3. 创建工作目录 ----
echo "创建工作目录: $INSTALL_DIR"
$SUDO mkdir -p "$INSTALL_DIR"

# ---- 4. 写入 JS 代理脚本 ----
echo "生成代理脚本: $PROXY_JS"
$SUDO tee "$PROXY_JS" >/dev/null <<'PROXY_EOF'
#!/usr/bin/env bun
import { serve } from "bun";

const PORT = __PORT__;

// 从代理自身的请求 URL 中剥离下游目标 URL，并做协议补全/纠正：
//   http://host:PORT/https://example.com/p  -> https://example.com/p
//   http://host:PORT/example.com/p          -> https://example.com/p   (自动补 https://)
//   http://host:PORT/https:/example.com/p   -> https://example.com/p   (修复被规范化的单斜杠)
function extractTarget(raw) {
  let path;
  const protoEnd = raw.indexOf("://");
  if (protoEnd >= 0) {
    const pathStart = raw.indexOf("/", protoEnd + 3);
    path = pathStart >= 0 ? raw.slice(pathStart + 1) : "";
  } else {
    path = raw;
  }
  path = path.replace(/^\/+/, "");
  if (!path) return "";
  // 修复 https:/ wss:/ 等被规范化的单斜杠形式
  path = path.replace(/^(wss?|https?):\/+/i, "$1://");
  // 没有协议时默认补 https://（WS 升级时再转 wss://）
  if (!/^(wss?|https?):\/\//i.test(path)) {
    path = "https://" + path;
  }
  return path;
}

// HTTP(S) → WS(S) 映射，已是 ws/wss 则保持
function toWsUrl(url) {
  if (/^wss?:\/\//i.test(url)) return url;
  return url.replace(/^https?:\/\//i, (m) =>
    /^https/i.test(m) ? "wss://" : "ws://",
  );
}

// 1005/1006 是保留 close code，不能直接传给 close()
function safeCloseCode(code) {
  if (!code || code === 1005 || code === 1006) return 1000;
  return code;
}

// hop-by-hop / WS 协议内部头，转发到下游时跳过
function shouldStripHeader(name) {
  const n = name.toLowerCase();
  return (
    n === "host" ||
    n === "connection" ||
    n === "upgrade" ||
    n === "content-length" ||
    n.startsWith("sec-websocket-")
  );
}

serve({
  port: PORT,

  async fetch(req, srv) {
    try {
      // ==== WebSocket 升级：同步 upgrade，下游连接延迟到 open 钩子 ====
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const httpTarget = extractTarget(req.url);
        if (!httpTarget) {
          return new Response("Missing target URL", { status: 400 });
        }
        const wsTarget = toWsUrl(httpTarget);

        const clientProtocols = (req.headers.get("sec-websocket-protocol") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const fwdHeaders = {};
        for (const [k, v] of req.headers) {
          if (!shouldStripHeader(k)) fwdHeaders[k] = v;
        }

        // 子协议必须在握手时立即回应；先 echo 客户端要求的第一个，
        // 若与下游协商不一致，下游会主动 close，逻辑上能闭环
        const upgradeOpts = {
          data: {
            wsTarget,
            clientProtocols,
            fwdHeaders,
            queue: [],
            ready: false,
            downstream: null,
          },
        };
        if (clientProtocols.length) {
          // Bun 要求 headers 是 Headers 实例或非空对象，空对象会触发校验失败
          const h = new Headers();
          h.set("sec-websocket-protocol", clientProtocols[0]);
          upgradeOpts.headers = h;
        }

        const upgraded = srv.upgrade(req, upgradeOpts);

        if (!upgraded) {
          console.error("[ws] upgrade rejected:", wsTarget);
          return new Response("Upgrade rejected", { status: 500 });
        }
        return undefined;
      }

      // ==== 普通 HTTP 转发 ====
      const target = extractTarget(req.url);

      if (!target) {
        const origin = new URL(req.url).origin;
        return new Response(
          "Usage: " + origin + "/<target-url>\n" +
          "协议可省略，默认 https；WebSocket 走 Upgrade 头自动判断。\n" +
          "示例:\n" +
          "  " + origin + "/example.com\n" +
          "  " + origin + "/https://example.com/path?q=1\n" +
          "  new WebSocket('ws://host:PORT/example.com/socket')\n",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }

      const reqHeaders = new Headers(req.headers);
      reqHeaders.delete("host");

      const resp = await fetch(target, {
        method: req.method,
        headers: reqHeaders,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
        // 自动跟随重定向：GitHub Releases 等需要多级跳转的场景必须开启，
        // 否则客户端拿到的是 302，跟随后又不会走代理，且部分客户端会卡住等待 body。
        redirect: "follow",
      });

      const respHeaders = new Headers(resp.headers);
      respHeaders.delete("content-encoding");
      respHeaders.delete("content-length");

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      console.error("[fetch error]", err?.stack || err);
      return new Response("Error: " + (err?.message || String(err)), { status: 500 });
    }
  },

  websocket: {
    // 长连接友好：5 分钟空闲超时，sendPings 自动保活，扛住常见 NAT 5min 超时
    idleTimeout: 300,
    sendPings: true,

    open(ws) {
      const { wsTarget, clientProtocols, fwdHeaders } = ws.data;

      let downstream;
      try {
        // Bun 客户端 WebSocket：
        // - 同时有 headers 时走 Bun 扩展 options 对象
        // - 只有 protocols 时走标准位置参数
        const hasHeaders = Object.keys(fwdHeaders).length > 0;
        if (hasHeaders) {
          const opts = { headers: fwdHeaders };
          if (clientProtocols.length) opts.protocols = clientProtocols;
          downstream = new WebSocket(wsTarget, opts);
        } else if (clientProtocols.length) {
          downstream = new WebSocket(wsTarget, clientProtocols);
        } else {
          downstream = new WebSocket(wsTarget);
        }
        downstream.binaryType = "arraybuffer";
      } catch (e) {
        console.error("[ws] downstream init failed:", e?.message || e, "url=", wsTarget);
        try { ws.close(1011, "downstream init failed"); } catch {}
        return;
      }

      ws.data.downstream = downstream;
      console.log("[ws] connecting downstream:", wsTarget);

      downstream.addEventListener("open", () => {
        ws.data.ready = true;
        const q = ws.data.queue;
        for (const m of q) {
          try { downstream.send(m); } catch {}
        }
        q.length = 0;
        console.log("[ws] downstream open:", wsTarget);
      });

      downstream.addEventListener("message", (e) => {
        try { ws.send(e.data); } catch {}
      });

      downstream.addEventListener("close", (e) => {
        try { ws.close(safeCloseCode(e.code), e.reason || ""); } catch {}
      });

      downstream.addEventListener("error", (e) => {
        console.error("[ws] downstream error:", e?.message || e?.type || "unknown");
        try { ws.close(1011, "downstream error"); } catch {}
      });
    },

    message(ws, msg) {
      const ds = ws.data.downstream;
      if (!ws.data.ready || !ds || ds.readyState !== 1) {
        ws.data.queue.push(msg);
        return;
      }
      try { ds.send(msg); } catch (e) {
        console.error("[ws] send to downstream failed:", e?.message || e);
      }
    },

    close(ws, code, reason) {
      const ds = ws.data.downstream;
      if (ds) {
        try { ds.close(safeCloseCode(code), reason || ""); } catch {}
      }
    },
  },
});

console.log("Any Proxy running on port " + PORT + " (HTTP + WebSocket)");
PROXY_EOF
$SUDO sed -i "s|__PORT__|$PORT|" "$PROXY_JS"
$SUDO chmod +x "$PROXY_JS"

# ---- 5. 创建 systemd 服务 ----
echo "创建 systemd 服务: $SERVICE_FILE"
BUN_DIR=$(dirname "$BUN_PATH")
$SUDO tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Any Proxy Service (Bun)
After=network.target

[Service]
Type=simple
ExecStart=$BUN_PATH $PROXY_JS
WorkingDirectory=$INSTALL_DIR
Restart=always
RestartSec=3
User=root
Environment=PATH=$BUN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

# ---- 6. systemd 重载/启用/启动 ----
echo "重新加载 systemd..."
$SUDO systemctl daemon-reload

echo "设置开机自启..."
$SUDO systemctl enable "${SERVICE_NAME}.service" >/dev/null 2>&1 || true

echo "启动服务..."
$SUDO systemctl restart "${SERVICE_NAME}.service"

# ---- 启动状态校验 ----
sleep 1
if $SUDO systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    echo "服务运行中"
else
    echo "服务启动失败，可执行: journalctl -u ${SERVICE_NAME}.service -n 50 --no-pager" >&2
fi

cat <<EOF

Any Proxy 安装完成

  端口:   $PORT
  Bun:    $BUN_PATH
  脚本:   $PROXY_JS
  服务:   ${SERVICE_NAME}.service

使用示例:
  curl 'http://127.0.0.1:$PORT/example.com'                  # 协议可省略，默认 https
  curl 'http://127.0.0.1:$PORT/https://example.com/path'   # 完整 URL
  new WebSocket('ws://127.0.0.1:$PORT/echo.websocket.events')   # WebSocket（Upgrade 头自动判断 ws/wss）

常用命令:
  systemctl status  ${SERVICE_NAME}      # 查看状态
  systemctl restart ${SERVICE_NAME}      # 重启服务
  systemctl stop    ${SERVICE_NAME}      # 停止服务
  journalctl -u     ${SERVICE_NAME} -f   # 查看实时日志

卸载: 重新运行本脚本，选择 "卸载"。
EOF
