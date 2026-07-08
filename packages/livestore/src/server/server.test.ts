import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { GraphRuntime } from "../engine/runtime.js";
import { createLivestoreServer, registerGraphRoutes, type GraphSocketOptions } from "./server.js";

const ENVELOPE = { value: 1, quality: "good", timestamp: 1 };

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

function makeRuntimeStub(): GraphRuntime {
  const stub = {
    isReady: () => true,
    counts: () => ({}),
    listNodes: () => [],
    getNode: () => undefined,
    getCvgValue: async () => ENVELOPE,
    getCurrentOrStale: () => ENVELOPE,
    watchCvgValue: async () => makeWatcher(),
  };
  return stub as unknown as GraphRuntime;
}

type Cleanup = () => Promise<void>;
const cleanups: Cleanup[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startServer(options?: GraphSocketOptions): Promise<string> {
  const server = await createLivestoreServer();
  registerGraphRoutes(server, makeRuntimeStub(), options);
  await server.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => server.close());
  const { port } = server.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/ws/graph`;
}

async function openSocket(url: string, opts?: { autoPong?: boolean }): Promise<WebSocket> {
  const ws = new WebSocket(url, opts);
  cleanups.push(async () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

function collectMessages(ws: WebSocket): Array<{ op: string; [key: string]: unknown }> {
  const messages: Array<{ op: string; [key: string]: unknown }> = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  return messages;
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

describe("/ws/graph", () => {
  it("sends the current value on subscribe", async () => {
    const url = await startServer();
    const ws = await openSocket(url);
    const messages = collectMessages(ws);

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["p1"] }));
    await waitFor(() => messages.length >= 1);

    expect(messages[0]).toEqual({ op: "value", propertyId: "p1", envelope: ENVELOPE });
  });

  it("closes connections that exceed the max payload", async () => {
    const url = await startServer();
    const ws = await openSocket(url);
    const closed = waitForClose(ws);

    ws.send("x".repeat(70 * 1024));

    expect(await closed).toBe(1009);
  });

  it("enforces the per-connection subscription cap", async () => {
    const url = await startServer({ maxWatchersPerConnection: 2 });
    const ws = await openSocket(url);
    const messages = collectMessages(ws);

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["a", "b", "c"] }));
    await waitFor(() => messages.length >= 3);

    expect(messages.filter((m) => m.op === "value")).toHaveLength(2);
    expect(messages.at(-1)).toEqual({ op: "error", error: "subscription limit reached" });
  });

  it("rate limits client ops", async () => {
    const url = await startServer({ opsBurst: 2, opsPerSecond: 0.0001 });
    const ws = await openSocket(url);
    const messages = collectMessages(ws);

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["r1"] }));
    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["r2"] }));
    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["r3"] }));
    await waitFor(() => messages.some((m) => m.op === "error"));

    expect(messages.filter((m) => m.op === "value")).toHaveLength(2);
    expect(messages.find((m) => m.op === "error")).toEqual({ op: "error", error: "rate limited" });
  });

  it("rejects messages with too many propertyIds", async () => {
    const url = await startServer({ maxPropertyIdsPerMessage: 2 });
    const ws = await openSocket(url);
    const messages = collectMessages(ws);

    ws.send(JSON.stringify({ op: "subscribe", propertyIds: ["a", "b", "c"] }));
    await waitFor(() => messages.length >= 1);

    expect(messages[0]).toEqual({ op: "error", error: "invalid message" });
  });

  it("terminates connections that stop answering pings", async () => {
    const url = await startServer({ heartbeatIntervalMs: 40, maxMissedPongs: 1 });
    const ws = await openSocket(url, { autoPong: false });

    // Abnormal closure (1006): the server terminates without a close frame.
    expect(await waitForClose(ws)).toBe(1006);
  });

  it("keeps responsive connections alive across heartbeats", async () => {
    const url = await startServer({ heartbeatIntervalMs: 40, maxMissedPongs: 1 });
    const ws = await openSocket(url); // default autoPong: true

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
