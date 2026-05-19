#!/usr/bin/env bash
set -euo pipefail

# =============================
#       Any Proxy Installer
# =============================

INSTALL_DIR="/opt/any-proxy"
PROXY_JS="$INSTALL_DIR/proxy.js"
SERVICE_NAME="any-proxy"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ALLOWLIST_FILE="/etc/any-proxy.allowlist"
DEFAULT_PORT=3000
DEFAULT_WS_QUEUE_LIMIT_BYTES=1048576
PROXY_JS_URL="${PROXY_JS_URL:-https://raw.githubusercontent.com/tokinx/any-proxy/refs/heads/main/proxy.js}"
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_SOURCE")" 2>/dev/null && pwd || pwd)
SOURCE_PROXY_JS="$SCRIPT_DIR/proxy.js"
TMP_PROXY_JS=""

# ---- Language selection ----
# Priority: --lang flag > ANY_PROXY_LANG env var > default (en)
LANG_CODE="${ANY_PROXY_LANG:-en}"
while (($#)); do
    case "$1" in
        --lang=*)  LANG_CODE="${1#*=}"; shift ;;
        --lang)    LANG_CODE="${2:-}"; shift 2 ;;
        --lang-*)  LANG_CODE="${1#--lang-}"; shift ;;
        *)         shift ;;
    esac
done
case "${LANG_CODE,,}" in
    zh|zh-cn|zh_cn|cn|chinese) LANG_CODE="zh-CN" ;;
    *)                         LANG_CODE="en" ;;
esac

# Translate helper: t "<English>" "<中文>"
t() {
    if [[ "$LANG_CODE" == "zh-CN" ]]; then
        printf '%s' "$2"
    else
        printf '%s' "$1"
    fi
}

cleanup() {
    if [[ -n "$TMP_PROXY_JS" && -f "$TMP_PROXY_JS" ]]; then
        rm -f "$TMP_PROXY_JS"
    fi
}

trap cleanup EXIT

# ---- Privilege check ----
if [[ $EUID -eq 0 ]]; then
    SUDO=""
elif command -v sudo &>/dev/null; then
    SUDO="sudo"
else
    echo "$(t "Root privileges or sudo are required" "需要 root 权限或 sudo 命令")" >&2
    exit 1
fi

# ---- systemd check ----
if ! command -v systemctl &>/dev/null; then
    echo "$(t "systemctl not found; this script only supports systemd-based systems" "未检测到 systemctl，脚本仅支持 systemd 系统")" >&2
    exit 1
fi

# ---- Interactive prompt: read from /dev/tty when available ----
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

# ---- Activate Bun that may exist outside PATH ----
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

# ---- Query the latest stable Bun release ----
get_latest_bun_version() {
    command -v curl &>/dev/null || return 0

    curl -fsSL --max-time 10 https://api.github.com/repos/oven-sh/bun/releases/latest 2>/dev/null \
        | grep -oE '"tag_name":[[:space:]]*"bun-v[^"]+"' \
        | head -1 \
        | sed -E 's/.*"bun-v([^"]+)".*/\1/' \
        || true
}

# ---- Resolve the proxy.js to install: prefer local copy, otherwise download ----
resolve_source_proxy_js() {
    if [[ -f "$SOURCE_PROXY_JS" ]]; then
        printf '%s' "$SOURCE_PROXY_JS"
        return 0
    fi

    if ! command -v curl &>/dev/null; then
        echo "$(t "Local proxy.js not found and curl is not available; cannot download from: $PROXY_JS_URL" \
                  "未找到本地 proxy.js，且未检测到 curl，无法下载: $PROXY_JS_URL")" >&2
        return 1
    fi

    TMP_PROXY_JS=$(mktemp)
    echo "$(t "Local proxy.js not found, downloading from: $PROXY_JS_URL" \
              "未找到本地 proxy.js，尝试下载: $PROXY_JS_URL")"
    if ! curl -fsSL "$PROXY_JS_URL" -o "$TMP_PROXY_JS"; then
        echo "$(t "Failed to download proxy.js from: $PROXY_JS_URL" \
                  "proxy.js 下载失败: $PROXY_JS_URL")" >&2
        rm -f "$TMP_PROXY_JS"
        TMP_PROXY_JS=""
        return 1
    fi

    printf '%s' "$TMP_PROXY_JS"
}

# ---- Allowlist entry management ----
normalize_allowlist_entry() {
    printf '%s' "$1" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'
}

validate_allowlist_entry() {
    local value="$1" ip prefix octet address zone
    [[ -n "$value" ]] || return 1
    [[ "$value" != *,* ]] || return 1
    [[ "$value" != *[[:space:]]* ]] || return 1

    if [[ "$value" =~ ^(([0-9]{1,3}\.){3}[0-9]{1,3})(/([0-9]|[12][0-9]|3[0-2]))?$ ]]; then
        IFS='/' read -r ip prefix <<<"$value"
        IFS='.' read -r -a octets <<<"$ip"
        for octet in "${octets[@]}"; do
            [[ "$octet" =~ ^[0-9]+$ ]] || return 1
            (( octet >= 0 && octet <= 255 )) || return 1
        done
        return 0
    fi

    if [[ "$value" == *:* ]]; then
        address="$value"
        if [[ "$value" == */* ]]; then
            address="${value%/*}"
            prefix=${value##*/}
            [[ "$prefix" =~ ^([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$ ]] || return 1
        fi

        if [[ "$address" == *%* ]]; then
            zone="${address#*%}"
            address="${address%%%*}"
            [[ -n "$zone" ]] || return 1
            [[ "$zone" != *[![:alnum:]_.-]* ]] || return 1
        fi

        if [[ "$address" == \[*\] ]]; then
            address="${address#[}"
            address="${address%]}"
        fi

        [[ -n "$address" ]] || return 1
        [[ "$address" == *:* ]] || return 1
        [[ "$address" != *[![:xdigit:]:.]* ]] || return 1
        return 0
    fi

    return 1
}

load_allowlist_entries() {
    ALLOWLIST_ENTRIES=()
    [[ -f "$ALLOWLIST_FILE" ]] || return 0

    mapfile -t ALLOWLIST_ENTRIES < <(
        sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$ALLOWLIST_FILE" 2>/dev/null \
            | while IFS= read -r line; do
                normalize_allowlist_entry "$line"
                printf '\n'
            done
    )
}

save_allowlist_entries() {
    local tmp
    tmp=$(mktemp)

    for entry in "${ALLOWLIST_ENTRIES[@]:-}"; do
        [[ -n "$entry" ]] || continue
        printf '%s\n' "$entry" >>"$tmp"
    done

    $SUDO install -m 600 "$tmp" "$ALLOWLIST_FILE"
    rm -f "$tmp"
}

allowlist_contains_entry() {
    local target="$1" entry
    for entry in "${ALLOWLIST_ENTRIES[@]:-}"; do
        [[ "$entry" == "$target" ]] && return 0
    done
    return 1
}

show_allowlist_entries() {
    local i
    load_allowlist_entries
    echo
    echo "$(t "Current access allowlist:" "当前访问白名单:")"
    if (( ${#ALLOWLIST_ENTRIES[@]} == 0 )); then
        echo "$(t "  (empty — all IPs allowed by default)" "  （空，默认允许所有 IP）")"
        return 0
    fi

    for i in "${!ALLOWLIST_ENTRIES[@]}"; do
        printf '  %d) %s\n' "$((i + 1))" "${ALLOWLIST_ENTRIES[$i]}"
    done
}

add_allowlist_entry() {
    local raw value
    raw=$(ask "$(t "Enter the IP or CIDR to add (e.g. 192.168.1.10, 192.168.0.0/16, 10.0.0.0/24)" \
                  "请输入要添加的 IP 或 CIDR（如 192.168.1.10、192.168.0.0/16、10.0.0.0/24）")" "")
    value=$(normalize_allowlist_entry "$raw")

    if ! validate_allowlist_entry "$value"; then
        echo "$(t "Invalid allowlist entry" "白名单格式无效")"
        return 1
    fi

    load_allowlist_entries
    if allowlist_contains_entry "$value"; then
        echo "$(t "Entry already exists" "该记录已存在")"
        return 0
    fi

    ALLOWLIST_ENTRIES+=("$value")
    save_allowlist_entries
    echo "$(t "Added: $value" "已添加白名单记录: $value")"
    echo "$(t "Re-run the installer to apply it to runtime access control" \
              "重新安装后会应用到运行时访问控制")"
}

delete_allowlist_entry() {
    local index choice i new_entries=()
    load_allowlist_entries

    if (( ${#ALLOWLIST_ENTRIES[@]} == 0 )); then
        echo "$(t "No allowlist entries to delete" "当前没有可删除的白名单记录")"
        return 0
    fi

    show_allowlist_entries
    choice=$(ask "$(t "Enter the index to delete" "请输入要删除的序号")" "")
    if [[ ! "$choice" =~ ^[0-9]+$ ]]; then
        echo "$(t "Invalid index" "序号无效")"
        return 1
    fi

    index=$((choice - 1))
    if (( index < 0 || index >= ${#ALLOWLIST_ENTRIES[@]} )); then
        echo "$(t "Index out of range" "序号超出范围")"
        return 1
    fi

    for i in "${!ALLOWLIST_ENTRIES[@]}"; do
        if (( i != index )); then
            new_entries+=("${ALLOWLIST_ENTRIES[$i]}")
        fi
    done

    echo "$(t "Removed: ${ALLOWLIST_ENTRIES[$index]}" "已删除白名单记录: ${ALLOWLIST_ENTRIES[$index]}")"
    ALLOWLIST_ENTRIES=("${new_entries[@]}")
    save_allowlist_entries
    echo "$(t "Re-run the installer to apply it to runtime access control" \
              "重新安装后会应用到运行时访问控制")"
}

manage_allowlist_menu() {
    while :; do
        show_allowlist_entries
        echo "$(t "Allowlist management:" "白名单管理:")"
        echo "$(t "  1) Add entry" "  1) 添加记录")"
        echo "$(t "  2) Delete entry" "  2) 删除记录")"
        echo "$(t "  *) Back" "  *) 返回")"
        ACTION=$(ask "$(t "Choose an option" "请输入选项")" "")
        case "$ACTION" in
            1) add_allowlist_entry ;;
            2) delete_allowlist_entry ;;
            *) break ;;
        esac
    done
}

get_allowlist_csv() {
    load_allowlist_entries
    local IFS=,
    printf '%s' "${ALLOWLIST_ENTRIES[*]:-}"
}

# ---- Detect the currently installed port ----
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
echo "$(t "      Any Proxy Installer    " "         Any Proxy 安装      ")"
echo "============================="

# ---- Detect existing install: prompt for reinstall/uninstall/exit ----
EXISTING_PORT=""
EXISTING_WS_QUEUE_LIMIT=""
if [[ -f "$PROXY_JS" || -f "$SERVICE_FILE" ]]; then
    EXISTING_PORT=$(detect_existing_port "$SERVICE_FILE" "$PROXY_JS")
    if [[ -f "$SERVICE_FILE" ]]; then
        EXISTING_WS_QUEUE_LIMIT=$(grep -oE '^Environment=WS_QUEUE_LIMIT_BYTES=[0-9]+' "$SERVICE_FILE" 2>/dev/null \
            | head -1 | grep -oE '[0-9]+' || true)
    fi
    echo
    if [[ -n "$EXISTING_PORT" ]]; then
        echo "$(t "Any Proxy is already installed (current port: $EXISTING_PORT)" \
                  "检测到 Any Proxy 已安装（当前端口: $EXISTING_PORT）")"
    else
        echo "$(t "Any Proxy is already installed" "检测到 Any Proxy 已安装")"
    fi
    while :; do
        echo "$(t "Choose an action:" "请选择操作:")"
        echo "$(t "  1) Reinstall" "  1) 重新安装")"
        echo "$(t "  2) Show allowlist" "  2) 查看白名单")"
        echo "$(t "  3) Add allowlist entry" "  3) 添加白名单")"
        echo "$(t "  4) Delete allowlist entry" "  4) 删除白名单")"
        echo "$(t "  5) Uninstall" "  5) 卸载")"
        echo "$(t "  *) Exit" "  *) 退出")"
        ACTION=$(ask "$(t "Choose an option" "请输入选项")" "")
        case "$ACTION" in
            1)
                echo "$(t "Preparing to reinstall..." "准备重新安装...")"
                $SUDO systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
                break
                ;;
            2)
                show_allowlist_entries
                ;;
            3)
                add_allowlist_entry
                ;;
            4)
                delete_allowlist_entry
                ;;
            5)
                echo "$(t "Uninstalling Any Proxy..." "正在卸载 Any Proxy...")"
                $SUDO systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
                $SUDO systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
                $SUDO rm -f "$SERVICE_FILE"
                $SUDO rm -rf "$INSTALL_DIR"
                $SUDO rm -f "$ALLOWLIST_FILE"
                $SUDO systemctl daemon-reload
                echo "$(t "Uninstall complete" "卸载完成")"
                exit 0
                ;;
            *)
                echo "$(t "Exiting" "退出脚本")"
                exit 0
                ;;
        esac
    done
fi

# ---- 1. Detect / install / upgrade Bun ----
load_bun_path || true

if ! command -v bun &>/dev/null; then
    echo "$(t "Bun is not installed" "未检测到 Bun")"
    INSTALL_BUN=$(ask "$(t "Install Bun now? [Y/n]" "是否现在安装 Bun？[Y/n]")" "Y")
    if [[ ! "$INSTALL_BUN" =~ ^[Yy]$ ]]; then
        echo "$(t "Bun is required; aborting" "未安装 Bun，无法继续")" >&2
        exit 1
    fi
    echo "$(t "Installing Bun dependencies..." "安装 Bun 依赖...")"
    if command -v apt-get &>/dev/null; then
        $SUDO apt-get update -y
        $SUDO apt-get install -y unzip curl tar xz-utils
    fi
    echo "$(t "Downloading and installing Bun..." "下载安装 Bun...")"
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="${BUN_INSTALL:-${HOME:-/root}/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if ! command -v bun &>/dev/null; then
        echo "$(t "Bun installation failed" "Bun 安装失败")" >&2
        exit 1
    fi
    echo "$(t "Bun installed: $(bun --version)" "Bun 安装完成: $(bun --version)")"
else
    BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
    echo "$(t "Bun is installed, current version: $BUN_VERSION" \
              "Bun 已安装，当前版本: $BUN_VERSION")"
    LATEST_BUN_VERSION=$(get_latest_bun_version)
    if [[ -n "$LATEST_BUN_VERSION" ]]; then
        if [[ "$BUN_VERSION" == "$LATEST_BUN_VERSION" ]]; then
            echo "$(t "Bun is up to date" "Bun 已是最新版本")"
        else
            echo "$(t "Latest Bun version: $LATEST_BUN_VERSION" \
                      "Bun 最新版本: $LATEST_BUN_VERSION")"
            UPGRADE_BUN=$(ask "$(t "Upgrade Bun to the latest version? [y/N]" \
                                    "是否升级 Bun 到最新版本？[y/N]")" "N")
            if [[ "$UPGRADE_BUN" =~ ^[Yy]$ ]]; then
                echo "$(t "Upgrading Bun..." "升级 Bun...")"
                bun upgrade || echo "$(t "Upgrade failed; continuing with the current version" \
                                          "升级失败，继续使用当前版本")"
                echo "$(t "Current version: $(bun --version)" "当前版本: $(bun --version)")"
            fi
        fi
    fi
fi

BUN_PATH=$(command -v bun)
if [[ -z "$BUN_PATH" ]]; then
    echo "$(t "Unable to locate the Bun binary" "无法定位 Bun 路径")" >&2
    exit 1
fi
echo "$(t "Bun path: $BUN_PATH" "Bun 路径: $BUN_PATH")"

# ---- 2. Port configuration (reuse existing if installed, otherwise default to 3000) ----
PORT_DEFAULT="${EXISTING_PORT:-$DEFAULT_PORT}"
while :; do
    PORT=$(ask "$(t "Enter the Any Proxy listen port" "请输入 Any Proxy 运行端口号")" "$PORT_DEFAULT")
    if [[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )); then
        break
    fi
    echo "$(t "Invalid port (must be an integer between 1 and 65535); try again" \
              "端口无效（应为 1~65535 的整数），请重新输入")"
done
echo "$(t "Using port: $PORT" "使用端口: $PORT")"

if [[ -z "$EXISTING_PORT" ]]; then
    CONFIGURE_ALLOWLIST=$(ask "$(t "Configure the runtime allowlist now? [y/N]" \
                                    "是否现在配置运行时白名单？[y/N]")" "N")
    if [[ "$CONFIGURE_ALLOWLIST" =~ ^[Yy]$ ]]; then
        manage_allowlist_menu
    fi
fi

# ---- 3. Create the working directory ----
echo "$(t "Creating working directory: $INSTALL_DIR" "创建工作目录: $INSTALL_DIR")"
$SUDO mkdir -p "$INSTALL_DIR"

# ---- 4. Install the proxy script ----
echo "$(t "Installing proxy script: $PROXY_JS" "安装代理脚本: $PROXY_JS")"
SOURCE_PROXY_JS_RESOLVED=$(resolve_source_proxy_js) || exit 1
$SUDO install -m 755 "$SOURCE_PROXY_JS_RESOLVED" "$PROXY_JS"

# ---- 5. Create the systemd unit ----
echo "$(t "Creating systemd unit: $SERVICE_FILE" "创建 systemd 服务: $SERVICE_FILE")"
BUN_DIR=$(dirname "$BUN_PATH")
ALLOWLIST_CSV=$(get_allowlist_csv)
ALLOWLIST_ENV_LINE=""
WS_QUEUE_LIMIT_VALUE="${WS_QUEUE_LIMIT_BYTES:-$EXISTING_WS_QUEUE_LIMIT}"
WS_QUEUE_LIMIT_ENV_LINE=""
if [[ -n "$ALLOWLIST_CSV" ]]; then
    ALLOWLIST_ENV_LINE="Environment=ALLOWLIST=$ALLOWLIST_CSV"
fi
if [[ -n "$WS_QUEUE_LIMIT_VALUE" ]]; then
    if [[ ! "$WS_QUEUE_LIMIT_VALUE" =~ ^[1-9][0-9]*$ ]]; then
        echo "$(t "Invalid WS_QUEUE_LIMIT_BYTES (must be a positive integer)" \
                  "WS_QUEUE_LIMIT_BYTES 无效（必须为正整数）")" >&2
        exit 1
    fi
    WS_QUEUE_LIMIT_ENV_LINE="Environment=WS_QUEUE_LIMIT_BYTES=$WS_QUEUE_LIMIT_VALUE"
else
    WS_QUEUE_LIMIT_VALUE="$DEFAULT_WS_QUEUE_LIMIT_BYTES"
fi
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
$ALLOWLIST_ENV_LINE
$WS_QUEUE_LIMIT_ENV_LINE

[Install]
WantedBy=multi-user.target
EOF

# ---- 6. Reload / enable / start systemd ----
echo "$(t "Reloading systemd..." "重新加载 systemd...")"
$SUDO systemctl daemon-reload

echo "$(t "Enabling service on boot..." "设置开机自启...")"
$SUDO systemctl enable "${SERVICE_NAME}.service" >/dev/null 2>&1 || true

echo "$(t "Starting service..." "启动服务...")"
$SUDO systemctl restart "${SERVICE_NAME}.service"

# ---- Startup verification ----
sleep 1
if $SUDO systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    echo "$(t "Service is running" "服务运行中")"
else
    echo "$(t "Service failed to start; check: journalctl -u ${SERVICE_NAME}.service -n 50 --no-pager" \
              "服务启动失败，可执行: journalctl -u ${SERVICE_NAME}.service -n 50 --no-pager")" >&2
fi

ALLOWLIST_DISPLAY="${ALLOWLIST_CSV:-$(t "(empty — all IPs allowed)" "（空，默认允许所有 IP）")}"
if [[ "$LANG_CODE" == "zh-CN" ]]; then
cat <<EOF

Any Proxy 安装完成

  端口:         $PORT
  Bun:          $BUN_PATH
  脚本:         $PROXY_JS
  服务:         ${SERVICE_NAME}.service
  白名单:       $ALLOWLIST_DISPLAY
  WS 队列上限:  $WS_QUEUE_LIMIT_VALUE bytes

使用示例:
  curl 'http://127.0.0.1:$PORT/example.com'                       # 协议可省略，默认 https
  curl 'http://127.0.0.1:$PORT/https://example.com/path'          # 完整 URL
  new WebSocket('ws://127.0.0.1:$PORT/echo.websocket.events')     # WebSocket（Upgrade 头自动判断 ws/wss）

常用命令:
  systemctl status  ${SERVICE_NAME}      # 查看状态
  systemctl restart ${SERVICE_NAME}      # 重启服务
  systemctl stop    ${SERVICE_NAME}      # 停止服务
  journalctl -u     ${SERVICE_NAME} -f   # 查看实时日志

卸载: 重新运行本脚本，选择「卸载」。
EOF
else
cat <<EOF

Any Proxy installation complete

  Port:            $PORT
  Bun:             $BUN_PATH
  Script:          $PROXY_JS
  Service:         ${SERVICE_NAME}.service
  Allowlist:       $ALLOWLIST_DISPLAY
  WS queue limit:  $WS_QUEUE_LIMIT_VALUE bytes

Examples:
  curl 'http://127.0.0.1:$PORT/example.com'                       # protocol optional, defaults to https
  curl 'http://127.0.0.1:$PORT/https://example.com/path'          # full URL
  new WebSocket('ws://127.0.0.1:$PORT/echo.websocket.events')     # WebSocket (ws/wss auto-detected via Upgrade header)

Common commands:
  systemctl status  ${SERVICE_NAME}      # service status
  systemctl restart ${SERVICE_NAME}      # restart
  systemctl stop    ${SERVICE_NAME}      # stop
  journalctl -u     ${SERVICE_NAME} -f   # follow logs

To uninstall: re-run this script and choose "Uninstall".
EOF
fi
