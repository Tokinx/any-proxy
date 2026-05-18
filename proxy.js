#!/usr/bin/env bun
import { serve } from "bun";

function resolvePort() {
  const raw = Bun.env.PORT || Bun.env.BUN_PORT || Bun.env.NODE_PORT || "3000";
  const port = Number.parseInt(raw, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }

  return port;
}

const PORT = resolvePort();
const ALLOWLIST_RAW =
  Bun.env.IP_ALLOWLIST || Bun.env.ALLOWLIST || Bun.env.WHITELIST || "";

function normalizeIpLiteral(input) {
  let ip = String(input || "").trim().toLowerCase();
  if (!ip) return "";
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }
  return ip.replace(/%.+$/, "");
}

function parseIpv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }

  return { version: 4, bits: 32, value };
}

function parseIpv6(ip) {
  if (!ip.includes(":")) return null;
  if (ip.indexOf("::") !== ip.lastIndexOf("::")) return null;

  const parseHextets = (part) => {
    if (!part) return [];
    const groups = part.split(":");
    const out = [];

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (!group) return null;

      if (group.includes(".")) {
        if (i !== groups.length - 1) return null;
        const ipv4 = parseIpv4(group);
        if (!ipv4) return null;
        out.push(Number((ipv4.value >> 16n) & 0xffffn).toString(16));
        out.push(Number(ipv4.value & 0xffffn).toString(16));
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(group);
    }

    return out;
  };

  const hasCompression = ip.includes("::");
  const [leftRaw, rightRaw = ""] = hasCompression ? ip.split("::") : [ip, ""];
  const left = parseHextets(leftRaw);
  const right = parseHextets(rightRaw);
  if (!left || !right) return null;

  let groups;
  if (hasCompression) {
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = left;
    if (groups.length !== 8) return null;
  }

  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    const hextet = Number.parseInt(group, 16);
    if (!Number.isInteger(hextet) || hextet < 0 || hextet > 0xffff) return null;
    value = (value << 16n) | BigInt(hextet);
  }

  return { version: 6, bits: 128, value };
}

function parseIpAddress(ip) {
  const normalized = normalizeIpLiteral(ip);
  if (!normalized) return null;
  if (normalized.startsWith("::ffff:") && normalized.includes(".")) {
    return parseIpv4(normalized.slice(7));
  }
  return parseIpv4(normalized) || parseIpv6(normalized);
}

function maskForPrefix(bits, prefix) {
  if (prefix <= 0) return 0n;
  if (prefix >= bits) return (1n << BigInt(bits)) - 1n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

function compileAllowlist(raw) {
  const rules = [];
  const seen = new Set();

  for (const entry of String(raw || "").split(",")) {
    const normalized = normalizeIpLiteral(entry);
    if (!normalized) continue;

    const [addressRaw, prefixRaw] = normalized.split("/", 2);
    const address = parseIpAddress(addressRaw);
    if (!address) continue;

    const prefix =
      prefixRaw === undefined || prefixRaw === ""
        ? address.bits
        : Number.parseInt(prefixRaw, 10);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) continue;

    const mask = maskForPrefix(address.bits, prefix);
    const network = address.value & mask;
    const key = `${address.version}:${prefix}:${network.toString(16)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rules.push({
      version: address.version,
      prefix,
      mask,
      network,
    });
  }

  return rules;
}

function matchesAllowlist(address, rule) {
  const parsed = parseIpAddress(address);
  if (!parsed || parsed.version !== rule.version) return false;
  return (parsed.value & rule.mask) === rule.network;
}

function isAllowedClientIp(address) {
  if (!ALLOWLIST.length) return true;
  if (!address) return false;
  return ALLOWLIST.some((rule) => matchesAllowlist(address, rule));
}

const ALLOWLIST = compileAllowlist(ALLOWLIST_RAW);

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
      const isWebSocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (!isWebSocket && !isAllowedClientIp(srv?.requestIP?.(req)?.address || "")) {
        return new Response("Forbidden", { status: 403 });
      }

      // ==== WebSocket 升级：同步 upgrade，下游连接延迟到 open 钩子 ====
      if (isWebSocket) {
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
