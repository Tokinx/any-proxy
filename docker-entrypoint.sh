#!/bin/sh
set -eu

BUN_INSTALL="${BUN_INSTALL:-/opt/bun}"
BUN_BIN="${BUN_INSTALL}/bin/bun"
BUN_VERSION="${BUN_VERSION:-latest}"

resolve_build() {
    arch="$(apk --print-arch)"
    case "${arch##*-}" in
        x86_64) echo "x64-musl-baseline" ;;
        aarch64) echo "aarch64-musl" ;;
        *)
            echo "error: unsupported architecture: $arch" >&2
            exit 1
            ;;
    esac
}

resolve_tag() {
    case "$1" in
        latest|canary|bun-v*) echo "$1" ;;
        v*) echo "bun-$1" ;;
        *) echo "bun-v$1" ;;
    esac
}

install_bun() {
    build="$(resolve_build)"
    tag="$(resolve_tag "${BUN_VERSION}")"

    case "${tag}" in
        latest) release="latest/download" ;;
        *) release="download/${tag}" ;;
    esac

    apk add --no-cache curl unzip >/dev/null
    mkdir -p "${BUN_INSTALL}/bin" /tmp/bun-install

    curl -fsSLo /tmp/bun.zip --compressed --retry 5 \
        "https://github.com/oven-sh/bun/releases/${release}/bun-linux-${build}.zip"
    unzip -q /tmp/bun.zip -d /tmp/bun-install
    mv "/tmp/bun-install/bun-linux-${build}/bun" "${BUN_BIN}"
    chmod +x "${BUN_BIN}"
    rm -rf /tmp/bun.zip /tmp/bun-install
}

if [ ! -x "${BUN_BIN}" ] || ! "${BUN_BIN}" --version >/dev/null 2>&1; then
    install_bun
fi

if [ "$#" -eq 0 ]; then
    set -- proxy.js
fi

if [ "${1}" = "bun" ]; then
    shift
fi

exec "${BUN_BIN}" "$@"
