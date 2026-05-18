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
