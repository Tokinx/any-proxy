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
PROXY_JS_URL="${PROXY_JS_URL:-https://raw.githubusercontent.com/tokinx/any-proxy/refs/heads/main/install.sh}"
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_SOURCE")" 2>/dev/null && pwd || pwd)
SOURCE_PROXY_JS="$SCRIPT_DIR/proxy.js"
TMP_PROXY_JS=""

cleanup() {
    if [[ -n "$TMP_PROXY_JS" && -f "$TMP_PROXY_JS" ]]; then
        rm -f "$TMP_PROXY_JS"
    fi
}

trap cleanup EXIT

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

# ---- 交互输入：优先从 /dev/tty 读取 ----
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

# ---- 查询 Bun 官方最新稳定版 ----
get_latest_bun_version() {
    command -v curl &>/dev/null || return 0

    curl -fsSL --max-time 10 https://api.github.com/repos/oven-sh/bun/releases/latest 2>/dev/null \
        | grep -oE '"tag_name":[[:space:]]*"bun-v[^"]+"' \
        | head -1 \
        | sed -E 's/.*"bun-v([^"]+)".*/\1/' \
        || true
}

# ---- 定位安装时使用的 proxy.js：优先本地，缺失则远程下载 ----
resolve_source_proxy_js() {
    if [[ -f "$SOURCE_PROXY_JS" ]]; then
        printf '%s' "$SOURCE_PROXY_JS"
        return 0
    fi

    if ! command -v curl &>/dev/null; then
        echo "未找到本地 proxy.js，且未检测到 curl，无法下载: $PROXY_JS_URL" >&2
        return 1
    fi

    TMP_PROXY_JS=$(mktemp)
    echo "未找到本地 proxy.js，尝试下载: $PROXY_JS_URL"
    if ! curl -fsSL "$PROXY_JS_URL" -o "$TMP_PROXY_JS"; then
        echo "proxy.js 下载失败: $PROXY_JS_URL" >&2
        rm -f "$TMP_PROXY_JS"
        TMP_PROXY_JS=""
        return 1
    fi

    printf '%s' "$TMP_PROXY_JS"
}

# ---- 提取当前安装的端口配置 ----
detect_existing_port() {
    local service_file="$1" proxy_file="$2" port=""

    if [[ -f "$service_file" ]]; then
        port=$(grep -oE '^Environment=PORT=[0-9]+' "$service_file" 2>/dev/null \
            | head -1 | grep -oE '[0-9]+' || true)
    fi

    if [[ -z "$port" && -f "$proxy_file" ]]; then
        port=$(grep -oE '^[[:space:]]*const[[:space:]]+PORT[[:space:]]*=[[:space:]]*[0-9]+' "$proxy_file" 2>/dev/null \
            | head -1 | grep -oE '[0-9]+' || true)
    fi

    printf '%s' "$port"
}

echo "============================="
echo "        Any Proxy 安装       "
echo "============================="

# ---- 已安装检测：提示重装/卸载/退出 ----
EXISTING_PORT=""
if [[ -f "$PROXY_JS" || -f "$SERVICE_FILE" ]]; then
    EXISTING_PORT=$(detect_existing_port "$SERVICE_FILE" "$PROXY_JS")
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
    LATEST_BUN_VERSION=$(get_latest_bun_version)
    if [[ -n "$LATEST_BUN_VERSION" ]]; then
        if [[ "$BUN_VERSION" == "$LATEST_BUN_VERSION" ]]; then
            echo "Bun 已是最新版本"
        else
            echo "Bun 最新版本: $LATEST_BUN_VERSION"
            UPGRADE_BUN=$(ask "是否升级 Bun 到最新版本？[y/N]" "N")
            if [[ "$UPGRADE_BUN" =~ ^[Yy]$ ]]; then
                echo "升级 Bun..."
                bun upgrade || echo "升级失败，继续使用当前版本"
                echo "当前版本: $(bun --version)"
            fi
        fi
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

# ---- 4. 安装 JS 代理脚本 ----
echo "安装代理脚本: $PROXY_JS"
SOURCE_PROXY_JS_RESOLVED=$(resolve_source_proxy_js) || exit 1
$SUDO install -m 755 "$SOURCE_PROXY_JS_RESOLVED" "$PROXY_JS"

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
Environment=PORT=$PORT

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
