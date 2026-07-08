import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { GraphRuntime } from "../engine/runtime.js";
import type { LivestorePrincipal } from "./auth.js";
import {
  createLivestoreServer,
  registerGraphRoutes,
  type GraphAuthenticator,
  type GraphSocketOptions,
} from "./server.js";

const ENVELOPE = { value: 1, quality: "good", timestamp: 1 };

const SITE_A = "site-a";
const SITE_B = "site-b";

// Bearer values recognized by the authenticator stub.
const USER_TOKEN_A = "user-token-site-a";
const USER_TOKEN_B = "user-token-site-b";
const APP_TOKEN_A = "rw_app_stub_site_a";

const NODE_A = { id: "node-a", name: "A", siteId: SITE_A, typeRef: null, typeContext: {}, properties: [] };
const NODE_B = { id: "node-b", name: "B", siteId: SITE_B, typeRef: null, typeContext: {}, properties: [] };

// KV watcher stub: yields nothing, stays pending until stop() — the route only
// needs the initial value (from getCvgValue) for these tests.
function makeWatcher() {
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => (resolveStop = resolve));
  return {
    stop: () => resolveStop(),
    async *[Symbol.asyncIterator]() {
      await stopped;
    },
  };
}

// Property tenancy: ids prefixed "x-" belong to SITE_B, everything else to
// SITE_A (unknown ids are indistinguishable from cross-site by design).
function makeRuntimeStub(): GraphRuntime {
  const stub = {
    isReady: () => true,
    counts: () => ({}),
    listNodes: () => [NODE_A, NODE_B],
    listNodesForSite: (siteId: string) => [NODE_A, NODE_B].filter((node) => node.siteId === siteId),
    getNode: (id: string) => [NODE_A, NODE_B].find((node) => node.id === id),
    getPropertySiteId: (id: string) => (id.startsWith("x-") ? SITE_B : SITE_A),
    getCvgValue: async () => ENVELOPE,
    getCurrentOrStale: () => ENVELOPE,
    watchCvgValue: async () => makeWatcher(),
  };
  return stub as unknown as GraphRuntime;
}

function principalFor(bearer: string): LivestorePrincipal | null {
  if (bearer === USER_TOKEN_A) {
    return { kind: "user", userId: "u1", workspaceId: "ws1", siteId: SITE_A, expMs: Date.now() + 15 * 60_000 };
  }
  if (bearer === USER_TOKEN_B) {
    return { kind: "user", userId: "u2", workspaceId: "ws1", siteId: SITE_B, expMs: Date.now() + 15 * 60_000 };
  }
  if (bearer === APP_TOKEN_A) {
    return { kind: "app", apiTokenId: "tok1", workspaceId: "ws1", siteId: SITE_A, expMs: null };
  }
  return null;
}

function makeAuthStub(): GraphAuthenticator & { appTokenValid: boolean } {
  const stub = {
    appTokenValid: true,
    authenticate: async (bearer: string) => principalFor(bearer),
    revalidateApiToken: async () => stub.appTokenValid,
  };
  return stub;
}

type Cleanup = () => Promise<void>;
const cleanups: Cleanup[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startServer(options?: GraphSocketOptions, auth: GraphAuthenticator = makeAuthStub()) {
  const server = await createLivestoreServer();
  registerGraphRoutes(server, makeRuntimeStub(), auth, options);
  await server.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => server.close());
  const { port } = server.server.address() as AddressInfo;
  return { server, wsUrl: `ws://127.0.0.1:${port}/ws/graph` };
}

// The message listener is attached before the handshake resolves so frames the
// server sends immediately after upgrade (e.g. ready after header auth) are
// never lost to an attach race.
async function openSocket(
  url: string,
  opts?: { autoPong?: boolean; headers?: Record<string, string> },
): Promise<{ ws: WebSocket; messages: Array<{ op: string; [key: string]: unknown }> }> {
  const ws = new WebSocket(url, opts);
  const messages: Array<{ op: string; [key: string]: unknown }> = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  cleanups.push(async () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, messages };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForClose(ws: WebSocket, timeoutMs = 2_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("close timed out")), timeoutMs);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// Open a socket and authenticate via first message; resolves once ready arrives.
async function openAuthedSocket(url: string, token = USER_TOKEN_A) {
  const { ws, messages } = await openSocket(url);
  ws.send(JSON.stringify({ op: "auth", token }));
  await waitFor(() => messages.some((m) => m.op === "ready"));
  return { ws, messages };
}

describe("http auth", () => {
  it("401s graph routes without a bearer and 200s with one, scoped to the principal's site", async () => {
    const { server } = await startServer();

    const anonymous = await server.inject({ method: "GET", url: "/graph/nodes" });
    expect(anonymous.statusCode).toBe(401);

    const badToken = await server.inject({
      method: "GET",
      url: "/graph/nodes",
      headers: { authorization: "Bearer nope" },
    });
    expect(badToken.statusCode).toBe(401);

    const ok = await server.inject({
      method: "GET",
      url: "/graph/nodes",
      headers: { authorization: `Bearer ${USER_TOKEN_A}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ data: [NODE_A] });
  });

  it("404s a cross-site node fetch identically to a missing one", async () => {
    const { server } = await startServer();
    const headers = { authorization: `Bearer ${USER_TOKEN_A}` };

    const own = await server.inject({ method: "GET", url: `/graph/nodes/${NODE_A.id}`, headers });
    expect(own.statusCode).toBe(200);

    const crossSite = await server.inject({ method: "GET", url: `/graph/nodes/${NODE_B.id}`, headers });
    const missing = await server.inject({ method: "GET", url: "/graph/nodes/nope", headers });
    expect(crossSite.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(crossSite.body).toEqual(missing.body);
  });

  it("keeps health probes public and free of graph counts", async () => {
    const { server } = await startServer();
    const health = await server.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
  });
});

describe("/ws/graph auth", () => {
  it("closes 4401 when no auth arrives within the timeout", async () => {
    const { wsUrl } = await startServer({ authTimeoutMs: 50 });
    const { ws } = await openSocket(wsUrl);
    expect(await waitForClose(ws)).toBe(4401);
  });

  it("closes 4401 on a non-auth first message", async () => {
    const { wsUrl } = await startServer();
    const { ws } = await openSocket(wsUrl);
    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["p1"] }));
    expect(await waitForClose(ws)).toBe(4401);
  });

  it("closes 4401 on a bad auth token", async () => {
    const { wsUrl } = await startServer();
    const { ws } = await openSocket(wsUrl);
    ws.send(JSON.stringify({ op: "auth", token: "nope" }));
    expect(await waitForClose(ws)).toBe(4401);
  });

  it("authenticates via first message and replies ready with the site", async () => {
    const { wsUrl } = await startServer();
    const { messages } = await openAuthedSocket(wsUrl);
    const ready = messages.find((m) => m.op === "ready");
    expect(ready).toMatchObject({ op: "ready", siteId: SITE_A });
    expect(typeof ready?.authExpiresAt).toBe("number");
  });

  it("authenticates via the Authorization header on upgrade", async () => {
    const { wsUrl } = await startServer();
    const { messages } = await openSocket(wsUrl, { headers: { authorization: `Bearer ${APP_TOKEN_A}` } });
    await waitFor(() => messages.some((m) => m.op === "ready"));
    expect(messages.find((m) => m.op === "ready")).toMatchObject({ siteId: SITE_A, authExpiresAt: null });
  });

  it("rejects cross-site propertyIds with FORBIDDEN and serves the rest", async () => {
    const { wsUrl } = await startServer();
    const { ws, messages } = await openAuthedSocket(wsUrl);

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["p1", "x-other"] }));
    await waitFor(() => messages.some((m) => m.op === "value") && messages.some((m) => m.code === "FORBIDDEN"));

    expect(messages.find((m) => m.code === "FORBIDDEN")).toMatchObject({ op: "error", propertyIds: ["x-other"] });
    expect(messages.filter((m) => m.op === "value")).toEqual([{ op: "value", propertyId: "p1", envelope: ENVELOPE }]);
  });

  it("rejects re-auth onto a different site with SITE_MISMATCH, keeping the old principal", async () => {
    const { wsUrl } = await startServer();
    const { ws, messages } = await openAuthedSocket(wsUrl);

    ws.send(JSON.stringify({ op: "auth", token: USER_TOKEN_B }));
    await waitFor(() => messages.some((m) => m.code === "SITE_MISMATCH"));

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["p1"] }));
    await waitFor(() => messages.some((m) => m.op === "value"));
    expect(messages.find((m) => m.op === "value")).toMatchObject({ propertyId: "p1" });
  });

  it("accepts same-site re-auth and re-arms expiry", async () => {
    const { wsUrl } = await startServer();
    const { ws, messages } = await openAuthedSocket(wsUrl);

    ws.send(JSON.stringify({ op: "auth", token: USER_TOKEN_A }));
    await waitFor(() => messages.filter((m) => m.op === "ready").length >= 2);
  });

  it("closes an app connection when periodic revalidation fails", async () => {
    const auth = makeAuthStub();
    const { wsUrl } = await startServer({ appRevalidateIntervalMs: 30 }, auth);
    const { ws, messages } = await openSocket(wsUrl, { headers: { authorization: `Bearer ${APP_TOKEN_A}` } });
    await waitFor(() => messages.some((m) => m.op === "ready"));

    auth.appTokenValid = false;
    expect(await waitForClose(ws)).toBe(4401);
    expect(messages.find((m) => m.code === "AUTH_EXPIRED")).toBeTruthy();
  });
});

describe("/ws/graph", () => {
  it("sends the current value on subscribe", async () => {
    const { wsUrl } = await startServer();
    const { ws, messages } = await openAuthedSocket(wsUrl);

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["p1"] }));
    await waitFor(() => messages.some((m) => m.op === "value"));

    expect(messages.find((m) => m.op === "value")).toEqual({ op: "value", propertyId: "p1", envelope: ENVELOPE });
  });

  it("closes connections that exceed the max payload", async () => {
    const { wsUrl } = await startServer();
    const { ws } = await openAuthedSocket(wsUrl);
    const closed = waitForClose(ws);

    ws.send("x".repeat(70 * 1024));

    expect(await closed).toBe(1009);
  });

  it("enforces the per-connection subscription cap", async () => {
    const { wsUrl } = await startServer({ maxWatchersPerConnection: 2 });
    const { ws, messages } = await openAuthedSocket(wsUrl);

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["a", "b", "c"] }));
    await waitFor(() => messages.some((m) => m.code === "SUBSCRIPTION_LIMIT"));

    expect(messages.filter((m) => m.op === "value")).toHaveLength(2);
  });

  it("rate limits client ops", async () => {
    const { wsUrl } = await startServer({ opsBurst: 3, opsPerSecond: 0.0001 });
    const { ws, messages } = await openAuthedSocket(wsUrl); // auth consumes one op

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["r1"] }));
    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["r2"] }));
    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["r3"] }));
    await waitFor(() => messages.some((m) => m.code === "RATE_LIMITED"));

    expect(messages.filter((m) => m.op === "value")).toHaveLength(2);
  });

  it("rejects messages with too many propertyIds", async () => {
    const { wsUrl } = await startServer({ maxPropertyIdsPerMessage: 2 });
    const { ws, messages } = await openAuthedSocket(wsUrl);

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["a", "b", "c"] }));
    await waitFor(() => messages.some((m) => m.code === "INVALID_MESSAGE"));

    expect(messages.filter((m) => m.op === "value")).toHaveLength(0);
  });

  it("terminates connections that stop answering pings", async () => {
    const { wsUrl } = await startServer({ heartbeatIntervalMs: 40, maxMissedPongs: 1 });
    const { ws } = await openSocket(wsUrl, { autoPong: false, headers: { authorization: `Bearer ${USER_TOKEN_A}` } });

    // Abnormal closure (1006): the server terminates without a close frame.
    expect(await waitForClose(ws)).toBe(1006);
  });

  it("keeps responsive connections alive across heartbeats", async () => {
    const { wsUrl } = await startServer({ heartbeatIntervalMs: 40, maxMissedPongs: 1 });
    const { ws } = await openAuthedSocket(wsUrl); // default autoPong: true

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
