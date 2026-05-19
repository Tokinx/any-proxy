import { describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_WS_QUEUE_LIMIT_BYTES,
  buildForwardHeaders,
  clearPendingMessages,
  compileAllowlist,
  createProxyServerOptions,
  enqueuePendingMessage,
  extractTarget,
  isAllowedWebSocketPeer,
  normalizeIpLiteral,
  parseIpAddress,
  resolveTargetAddresses,
  resolveWsQueueLimitBytes,
  safeCloseCode,
  toWsUrl,
} from "../proxy.js";

const silentLogger = {
  log() {},
  error() {},
};

function createWebSocketRequest(target) {
  return new Request(`http://proxy/${target}`, {
    headers: {
      upgrade: "websocket",
    },
  });
}

function createHttpRequest(target) {
  return new Request(`http://proxy/${target}`);
}

describe("proxy runtime helpers", () => {
  test("IP parsing and allowlist compilation handle IPv4, IPv6 and duplicates", () => {
    expect(normalizeIpLiteral("[fe80::1%eth0]")).toBe("fe80::1");
    expect(parseIpAddress("192.168.0.1")?.version).toBe(4);
    expect(parseIpAddress("2001:db8::1")?.version).toBe(6);
    expect(parseIpAddress("::ffff:192.168.0.1")?.version).toBe(4);

    const allowlist = compileAllowlist("10.0.0.1,10.0.0.1,2001:db8::/64,invalid");
    expect(allowlist).toHaveLength(2);
  });

  test("target extraction and protocol conversion keep proxy URL normalization stable", () => {
    expect(extractTarget("http://proxy/https://example.com/a")).toBe("https://example.com/a");
    expect(extractTarget("http://proxy/example.com/a")).toBe("https://example.com/a");
    expect(extractTarget("http://proxy/https:/example.com/a")).toBe("https://example.com/a");
    expect(toWsUrl("https://example.com/socket")).toBe("wss://example.com/socket");
    expect(toWsUrl("ws://example.com/socket")).toBe("ws://example.com/socket");
  });

  test("header forwarding strips hop-by-hop and websocket-internal headers", () => {
    const headers = new Headers({
      host: "proxy",
      connection: "upgrade",
      upgrade: "websocket",
      "content-length": "12",
      "sec-websocket-protocol": "chat",
      authorization: "Bearer token",
      "x-test": "1",
    });

    const forwarded = buildForwardHeaders(new Request("http://proxy/example.com", { headers }));
    expect(forwarded).toEqual({
      authorization: "Bearer token",
      "x-test": "1",
    });
  });

  test("queue helpers track buffered bytes and can be cleared", () => {
    const state = {
      queue: [],
      queueBytes: 0,
      queueLimitBytes: 6,
    };

    expect(enqueuePendingMessage(state, "abc")).toBe(true);
    expect(enqueuePendingMessage(state, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(state.queueBytes).toBe(6);
    expect(enqueuePendingMessage(state, "x")).toBe(false);

    clearPendingMessages(state);
    expect(state.queue).toEqual([]);
    expect(state.queueBytes).toBe(0);
  });

  test("target resolution skips DNS for literal IPs and tolerates lookup failures", async () => {
    const dnsLookup = mock(async () => [{ address: "203.0.113.10" }]);
    expect(await resolveTargetAddresses("https://203.0.113.10/socket", dnsLookup, silentLogger)).toEqual([
      "203.0.113.10",
    ]);
    expect(dnsLookup).toHaveBeenCalledTimes(0);

    const failingLookup = mock(async () => {
      throw new Error("lookup failed");
    });
    expect(
      await resolveTargetAddresses("https://example.com/socket", failingLookup, silentLogger),
    ).toEqual([]);
  });

  test("safeCloseCode normalizes reserved close codes", () => {
    expect(safeCloseCode(1005)).toBe(1000);
    expect(safeCloseCode(1006)).toBe(1000);
    expect(safeCloseCode(1013)).toBe(1013);
  });

  test("resolveWsQueueLimitBytes supports default and custom values", () => {
    expect(resolveWsQueueLimitBytes({})).toBe(DEFAULT_WS_QUEUE_LIMIT_BYTES);
    expect(resolveWsQueueLimitBytes({ WS_QUEUE_LIMIT_BYTES: "2048" })).toBe(2048);
  });

  test("WebSocket allowlist accepts an allowlisted client IP without DNS lookup", async () => {
    const dnsLookup = mock(async () => [{ address: "203.0.113.10" }]);
    const allowed = await isAllowedWebSocketPeer({
      clientAddress: "10.0.0.42",
      targetUrl: "https://example.com/socket",
      allowlist: [{ version: 4, prefix: 24, mask: 0xffffff00n, network: 0x0a000000n }],
      dnsLookup,
      logger: silentLogger,
    });

    expect(allowed).toBe(true);
    expect(dnsLookup).toHaveBeenCalledTimes(0);
  });

  test("WebSocket allowlist accepts an allowlisted downstream target after DNS resolution", async () => {
    const dnsLookup = mock(async () => [{ address: "203.0.113.10" }]);
    const app = createProxyServerOptions({
      env: {
        PORT: "3000",
        ALLOWLIST: "203.0.113.10",
      },
      dnsLookup,
      logger: silentLogger,
    });

    let upgradeOptions;
    const server = {
      requestIP: () => ({ address: "198.51.100.7" }),
      upgrade(_req, options) {
        upgradeOptions = options;
        return true;
      },
    };

    const response = await app.fetch(createWebSocketRequest("example.com/socket"), server);

    expect(response).toBeUndefined();
    expect(dnsLookup).toHaveBeenCalledTimes(1);
    expect(upgradeOptions.data.wsTarget).toBe("wss://example.com/socket");
    expect(upgradeOptions.data.queueLimitBytes).toBe(DEFAULT_WS_QUEUE_LIMIT_BYTES);
  });

  test("WebSocket upgrade is denied when neither peer matches the allowlist", async () => {
    const dnsLookup = mock(async () => [{ address: "203.0.113.10" }]);
    const app = createProxyServerOptions({
      env: {
        PORT: "3000",
        ALLOWLIST: "10.0.0.0/24",
      },
      dnsLookup,
      logger: silentLogger,
    });

    const upgrade = mock(() => true);
    const server = {
      requestIP: () => ({ address: "198.51.100.7" }),
      upgrade,
    };

    const response = await app.fetch(createWebSocketRequest("example.com/socket"), server);

    expect(response.status).toBe(403);
    expect(upgrade).toHaveBeenCalledTimes(0);
  });

  test("HTTP path still checks client source IP only", async () => {
    const fetchImpl = mock(async () => new Response("ok"));
    const app = createProxyServerOptions({
      env: {
        PORT: "3000",
        ALLOWLIST: "203.0.113.10",
      },
      fetchImpl,
      logger: silentLogger,
    });

    const server = {
      requestIP: () => ({ address: "198.51.100.7" }),
    };

    const response = await app.fetch(createHttpRequest("https://203.0.113.10/path"), server);

    expect(response.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  test("HTTP forwarding removes stale payload headers from downstream responses", async () => {
    const fetchImpl = mock(
      async () =>
        new Response("ok", {
          status: 201,
          headers: {
            "content-encoding": "gzip",
            "content-length": "2",
            "x-test": "1",
          },
        }),
    );
    const app = createProxyServerOptions({
      env: {
        PORT: "3000",
        ALLOWLIST: "198.51.100.0/24",
      },
      fetchImpl,
      logger: silentLogger,
    });

    const response = await app.fetch(createHttpRequest("https://example.com/path"), {
      requestIP: () => ({ address: "198.51.100.7" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("1");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  test("queued WebSocket messages are capped by WS_QUEUE_LIMIT_BYTES", () => {
    const app = createProxyServerOptions({
      env: {
        PORT: "3000",
        ALLOWLIST: "",
        WS_QUEUE_LIMIT_BYTES: "5",
      },
      logger: silentLogger,
    });

    const ws = {
      data: {
        wsTarget: "wss://example.com/socket",
        queue: [],
        queueBytes: 0,
        queueLimitBytes: 5,
        ready: false,
        downstream: null,
      },
      close: mock(() => {}),
    };

    app.websocket.message(ws, "abc");
    expect(ws.data.queue).toEqual(["abc"]);
    expect(ws.data.queueBytes).toBe(3);

    app.websocket.message(ws, "def");
    expect(ws.close).toHaveBeenCalledWith(1013, "queue limit exceeded");
    expect(ws.data.queue).toEqual([]);
    expect(ws.data.queueBytes).toBe(0);
  });

  test("websocket.open wires the downstream socket and flushes queued messages", () => {
    const downstreamInstances = [];

    class FakeWebSocket {
      constructor(url, init) {
        this.url = url;
        this.init = init;
        this.readyState = 0;
        this.binaryType = "blob";
        this.listeners = new Map();
        this.sent = [];
        downstreamInstances.push(this);
      }

      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      }

      emit(type, event = {}) {
        if (type === "open") this.readyState = 1;
        this.listeners.get(type)?.(event);
      }

      send(message) {
        this.sent.push(message);
      }

      close(code, reason) {
        this.closed = { code, reason };
      }
    }

    const app = createProxyServerOptions({
      env: {
        PORT: "3000",
        ALLOWLIST: "",
        WS_QUEUE_LIMIT_BYTES: "16",
      },
      WebSocketCtor: FakeWebSocket,
      logger: silentLogger,
    });

    const clientWs = {
      data: {
        wsTarget: "wss://example.com/socket",
        clientProtocols: ["chat"],
        fwdHeaders: { authorization: "Bearer token" },
        queue: ["hello", "world"],
        queueBytes: 10,
        queueLimitBytes: 16,
        ready: false,
        downstream: null,
      },
      send: mock(() => {}),
      close: mock(() => {}),
    };

    app.websocket.open(clientWs);

    const downstream = downstreamInstances[0];
    expect(downstream.url).toBe("wss://example.com/socket");
    expect(downstream.init).toEqual({
      headers: { authorization: "Bearer token" },
      protocols: ["chat"],
    });
    expect(downstream.binaryType).toBe("arraybuffer");

    downstream.emit("open");
    expect(clientWs.data.ready).toBe(true);
    expect(downstream.sent).toEqual(["hello", "world"]);
    expect(clientWs.data.queue).toEqual([]);
    expect(clientWs.data.queueBytes).toBe(0);

    downstream.emit("message", { data: "pong" });
    expect(clientWs.send).toHaveBeenCalledWith("pong");

    downstream.emit("close", { code: 1005, reason: "done" });
    expect(clientWs.close).toHaveBeenCalledWith(1000, "done");
  });
});
