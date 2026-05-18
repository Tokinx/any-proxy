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

// Strip the downstream target URL from this proxy's own request URL,
// fixing protocol completion / normalization edge cases:
//   http://host:PORT/https://example.com/p  -> https://example.com/p
//   http://host:PORT/example.com/p          -> https://example.com/p   (default to https://)
//   http://host:PORT/https:/example.com/p   -> https://example.com/p   (restore single-slash normalization)
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
  // Restore single-slash forms like https:/ or wss:/ produced by URL normalization
  path = path.replace(/^(wss?|https?):\/+/i, "$1://");
  // Default to https:// when no protocol is present (WS upgrade re-maps to wss:// later)
  if (!/^(wss?|https?):\/\//i.test(path)) {
    path = "https://" + path;
  }
  return path;
}

// Map HTTP(S) -> WS(S); leave ws/wss as-is
function toWsUrl(url) {
  if (/^wss?:\/\//i.test(url)) return url;
  return url.replace(/^https?:\/\//i, (m) =>
    /^https/i.test(m) ? "wss://" : "ws://",
  );
}

// 1005/1006 are reserved close codes and cannot be passed to close() directly
function safeCloseCode(code) {
  if (!code || code === 1005 || code === 1006) return 1000;
  return code;
}

// Hop-by-hop / WS-internal headers — strip when forwarding to the downstream
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

      // ==== WebSocket upgrade: handshake synchronously, connect downstream lazily in the open hook ====
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

        // Subprotocol must be answered during the handshake; echo the first one the client asked for.
        // If the downstream disagrees, it will close the connection on its own — the loop closes cleanly.
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
          // Bun requires headers to be a Headers instance or a non-empty object; an empty object fails validation
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

      // ==== Plain HTTP forward ====
      const target = extractTarget(req.url);

      if (!target) {
        const origin = new URL(req.url).origin;
        return new Response(
          "Usage: " + origin + "/<target-url>\n" +
          "Protocol is optional and defaults to https; WebSocket is detected via the Upgrade header.\n" +
          "Examples:\n" +
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
        // Auto-follow redirects: required for multi-hop targets like GitHub Releases.
        // Otherwise the client gets a 302, the follow-up does not go through the proxy,
        // and some clients hang waiting for a body.
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
    // Long-connection friendly: 5-minute idle timeout, sendPings keeps the link alive across the common 5-min NAT timeout
    idleTimeout: 300,
    sendPings: true,

    open(ws) {
      const { wsTarget, clientProtocols, fwdHeaders } = ws.data;

      let downstream;
      try {
        // Bun client WebSocket:
        // - when headers are present, use the Bun-extended options object
        // - protocols only -> use the standard positional argument
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
