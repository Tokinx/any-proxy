#!/usr/bin/env bun
import { serve } from "bun";
import { Buffer } from "node:buffer";
import { lookup as defaultDnsLookup } from "node:dns/promises";

export const DEFAULT_PORT = 3000;
export const DEFAULT_WS_QUEUE_LIMIT_BYTES = 1024 * 1024;

export function resolvePort(env = Bun.env) {
  const raw = env.PORT || String(DEFAULT_PORT);
  const port = Number.parseInt(raw, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }

  return port;
}

export function resolveWsQueueLimitBytes(env = Bun.env) {
  const raw = env.WS_QUEUE_LIMIT_BYTES || String(DEFAULT_WS_QUEUE_LIMIT_BYTES);
  const limit = Number.parseInt(raw, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid WS_QUEUE_LIMIT_BYTES: ${raw}`);
  }

  return limit;
}

export function normalizeIpLiteral(input) {
  let ip = String(input || "").trim().toLowerCase();
  if (!ip) return "";
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }
  return ip.replace(/%.+$/, "");
}

export function parseIpv4(ip) {
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

export function parseIpv6(ip) {
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

export function parseIpAddress(ip) {
  const normalized = normalizeIpLiteral(ip);
  if (!normalized) return null;
  if (normalized.startsWith("::ffff:") && normalized.includes(".")) {
    return parseIpv4(normalized.slice(7));
  }
  return parseIpv4(normalized) || parseIpv6(normalized);
}

export function maskForPrefix(bits, prefix) {
  if (prefix <= 0) return 0n;
  if (prefix >= bits) return (1n << BigInt(bits)) - 1n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

export function compileAllowlist(raw) {
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

export function matchesAllowlist(address, rule) {
  const parsed = parseIpAddress(address);
  if (!parsed || parsed.version !== rule.version) return false;
  return (parsed.value & rule.mask) === rule.network;
}

export function isAllowedAddress(address, allowlist) {
  if (!allowlist.length) return true;
  if (!address) return false;
  return allowlist.some((rule) => matchesAllowlist(address, rule));
}

// Strip the downstream target URL from this proxy's own request URL,
// fixing protocol completion / normalization edge cases:
//   http://host:PORT/https://example.com/p  -> https://example.com/p
//   http://host:PORT/example.com/p          -> https://example.com/p   (default to https://)
//   http://host:PORT/https:/example.com/p   -> https://example.com/p   (restore single-slash normalization)
export function extractTarget(raw) {
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
  path = path.replace(/^(wss?|https?):\/+/i, "$1://");
  if (!/^(wss?|https?):\/\//i.test(path)) {
    path = "https://" + path;
  }
  return path;
}

export function toWsUrl(url) {
  if (/^wss?:\/\//i.test(url)) return url;
  return url.replace(/^https?:\/\//i, (match) =>
    /^https/i.test(match) ? "wss://" : "ws://",
  );
}

export function safeCloseCode(code) {
  if (!code || code === 1005 || code === 1006) return 1000;
  return code;
}

export function shouldStripHeader(name) {
  const normalized = name.toLowerCase();
  return (
    normalized === "host" ||
    normalized === "connection" ||
    normalized === "upgrade" ||
    normalized === "content-length" ||
    normalized.startsWith("sec-websocket-")
  );
}

export function buildForwardHeaders(req) {
  const forwardHeaders = {};
  for (const [key, value] of req.headers) {
    if (!shouldStripHeader(key)) forwardHeaders[key] = value;
  }
  return forwardHeaders;
}

export function createRuntimeConfig(env = Bun.env) {
  return {
    port: resolvePort(env),
    allowlistRaw: env.ALLOWLIST || "",
    allowlist: compileAllowlist(env.ALLOWLIST || ""),
    wsQueueLimitBytes: resolveWsQueueLimitBytes(env),
  };
}

export function getRequestClientAddress(server, req) {
  return server?.requestIP?.(req)?.address || "";
}

export function getTargetHostname(targetUrl) {
  try {
    return normalizeIpLiteral(new URL(targetUrl).hostname);
  } catch {
    return "";
  }
}

export async function resolveTargetAddresses(
  targetUrl,
  dnsLookup = defaultDnsLookup,
  logger = null,
) {
  const hostname = getTargetHostname(targetUrl);
  if (!hostname) return [];

  if (parseIpAddress(hostname)) {
    return [hostname];
  }

  try {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    return [...new Set(records.map(({ address }) => normalizeIpLiteral(address)).filter(Boolean))];
  } catch (error) {
    logger?.error?.("[ws] target lookup failed:", error?.message || error, "host=", hostname);
    return [];
  }
}

export async function isAllowedWebSocketPeer({
  clientAddress,
  targetUrl,
  allowlist,
  dnsLookup = defaultDnsLookup,
  logger = null,
}) {
  if (!allowlist.length) return true;
  if (isAllowedAddress(clientAddress, allowlist)) return true;

  const targetAddresses = await resolveTargetAddresses(targetUrl, dnsLookup, logger);
  return targetAddresses.some((address) => isAllowedAddress(address, allowlist));
}

export function getMessageSize(message) {
  if (typeof message === "string") {
    return Buffer.byteLength(message);
  }

  if (message instanceof ArrayBuffer) {
    return message.byteLength;
  }

  if (ArrayBuffer.isView(message)) {
    return message.byteLength;
  }

  if (typeof Blob !== "undefined" && message instanceof Blob) {
    return message.size;
  }

  return Buffer.byteLength(String(message));
}

export function clearPendingMessages(state) {
  state.queue.length = 0;
  state.queueBytes = 0;
}

export function enqueuePendingMessage(state, message) {
  const nextSize = state.queueBytes + getMessageSize(message);
  if (nextSize > state.queueLimitBytes) {
    return false;
  }

  state.queue.push(message);
  state.queueBytes = nextSize;
  return true;
}

export function createProxyServerOptions({
  env = Bun.env,
  fetchImpl = fetch,
  WebSocketCtor = WebSocket,
  dnsLookup = defaultDnsLookup,
  logger = console,
} = {}) {
  const config = createRuntimeConfig(env);

  return {
    port: config.port,

    async fetch(req, srv) {
      try {
        const isWebSocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
        const clientAddress = getRequestClientAddress(srv, req);

        if (!isWebSocket && !isAllowedAddress(clientAddress, config.allowlist)) {
          return new Response("Forbidden", { status: 403 });
        }

        if (isWebSocket) {
          const httpTarget = extractTarget(req.url);
          if (!httpTarget) {
            return new Response("Missing target URL", { status: 400 });
          }

          const allowed = await isAllowedWebSocketPeer({
            clientAddress,
            targetUrl: httpTarget,
            allowlist: config.allowlist,
            dnsLookup,
            logger,
          });
          if (!allowed) {
            logger.error?.(
              "[ws] allowlist denied:",
              `client=${clientAddress || "unknown"}`,
              `target=${httpTarget}`,
            );
            return new Response("Forbidden", { status: 403 });
          }

          const wsTarget = toWsUrl(httpTarget);
          const clientProtocols = (req.headers.get("sec-websocket-protocol") || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);

          const upgradeOptions = {
            data: {
              wsTarget,
              clientProtocols,
              fwdHeaders: buildForwardHeaders(req),
              queue: [],
              queueBytes: 0,
              queueLimitBytes: config.wsQueueLimitBytes,
              ready: false,
              downstream: null,
            },
          };

          if (clientProtocols.length) {
            const headers = new Headers();
            headers.set("sec-websocket-protocol", clientProtocols[0]);
            upgradeOptions.headers = headers;
          }

          const upgraded = srv.upgrade(req, upgradeOptions);
          if (!upgraded) {
            logger.error?.("[ws] upgrade rejected:", wsTarget);
            return new Response("Upgrade rejected", { status: 500 });
          }

          return undefined;
        }

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

        const resp = await fetchImpl(target, {
          method: req.method,
          headers: reqHeaders,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
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
        logger.error?.("[fetch error]", err?.stack || err);
        return new Response("Error: " + (err?.message || String(err)), { status: 500 });
      }
    },

    websocket: {
      idleTimeout: 300,
      sendPings: true,

      open(ws) {
        const { wsTarget, clientProtocols, fwdHeaders } = ws.data;

        let downstream;
        try {
          const hasHeaders = Object.keys(fwdHeaders).length > 0;
          if (hasHeaders) {
            const options = { headers: fwdHeaders };
            if (clientProtocols.length) options.protocols = clientProtocols;
            downstream = new WebSocketCtor(wsTarget, options);
          } else if (clientProtocols.length) {
            downstream = new WebSocketCtor(wsTarget, clientProtocols);
          } else {
            downstream = new WebSocketCtor(wsTarget);
          }
          downstream.binaryType = "arraybuffer";
        } catch (error) {
          logger.error?.("[ws] downstream init failed:", error?.message || error, "url=", wsTarget);
          try {
            ws.close(1011, "downstream init failed");
          } catch {}
          return;
        }

        ws.data.downstream = downstream;
        logger.log?.("[ws] connecting downstream:", wsTarget);

        downstream.addEventListener("open", () => {
          ws.data.ready = true;
          for (const message of ws.data.queue) {
            try {
              downstream.send(message);
            } catch {}
          }
          clearPendingMessages(ws.data);
          logger.log?.("[ws] downstream open:", wsTarget);
        });

        downstream.addEventListener("message", (event) => {
          try {
            ws.send(event.data);
          } catch {}
        });

        downstream.addEventListener("close", (event) => {
          clearPendingMessages(ws.data);
          try {
            ws.close(safeCloseCode(event.code), event.reason || "");
          } catch {}
        });

        downstream.addEventListener("error", (event) => {
          logger.error?.("[ws] downstream error:", event?.message || event?.type || "unknown");
          clearPendingMessages(ws.data);
          try {
            ws.close(1011, "downstream error");
          } catch {}
        });
      },

      message(ws, message) {
        const downstream = ws.data.downstream;
        if (!ws.data.ready || !downstream || downstream.readyState !== 1) {
          if (!enqueuePendingMessage(ws.data, message)) {
            logger.error?.("[ws] queue limit exceeded:", ws.data.queueLimitBytes, "url=", ws.data.wsTarget);
            clearPendingMessages(ws.data);
            if (downstream && downstream.readyState < 2) {
              try {
                downstream.close(1013, "queue limit exceeded");
              } catch {}
            }
            try {
              ws.close(1013, "queue limit exceeded");
            } catch {}
          }
          return;
        }

        try {
          downstream.send(message);
        } catch (error) {
          logger.error?.("[ws] send to downstream failed:", error?.message || error);
        }
      },

      close(ws, code, reason) {
        clearPendingMessages(ws.data);
        const downstream = ws.data.downstream;
        if (downstream) {
          try {
            downstream.close(safeCloseCode(code), reason || "");
          } catch {}
        }
      },
    },
  };
}

export function createProxyServer(options = {}) {
  return serve(createProxyServerOptions(options));
}

if (import.meta.main) {
  const server = createProxyServer();
  console.log("Any Proxy running on port " + server.port + " (HTTP + WebSocket)");
}
