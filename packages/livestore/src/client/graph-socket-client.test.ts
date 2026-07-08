import { afterEach, describe, expect, it } from "vitest";

import { ReconnectingGraphSocket, type GraphSocketLike } from "./graph-socket-client.js";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

class FakeSocket implements GraphSocketLike {
  readyState = WS_CONNECTING;
  sent: Array<{ op: string; propertyIds?: string[]; token?: string }> = [];
  private listeners = new Map<string, Array<(event: { data: unknown; code?: number }) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.emitClose();
  }

  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: { data: unknown; code?: number }) => void,
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emitOpen(): void {
    this.readyState = WS_OPEN;
    for (const listener of this.listeners.get("open") ?? []) listener({ data: undefined });
  }

  emitClose(code?: number): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    for (const listener of this.listeners.get("close") ?? []) listener({ data: undefined, code });
  }

  emitMessage(payload: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(payload) });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeHarness(
  onValue: (propertyId: string, envelope: unknown) => void = () => {},
  extra?: { getToken?: () => string | Promise<string> },
) {
  const sockets: FakeSocket[] = [];
  const client = new ReconnectingGraphSocket({
    url: "ws://test/ws/graph",
    onValue,
    ...extra,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    initialBackoffMs: 1,
    maxBackoffMs: 5,
  });
  return { sockets, client };
}

const clients: ReconnectingGraphSocket[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()?.close();
});

describe("ReconnectingGraphSocket", () => {
  it("sends subscribes while open and dispatches values", () => {
    const values: Array<[string, unknown]> = [];
    const { sockets, client } = makeHarness((propertyId, envelope) => values.push([propertyId, envelope]));
    clients.push(client);

    sockets[0].emitOpen();
    client.subscribe(["a", "b"]);
    expect(sockets[0].sent).toEqual([{ op: "subscribe", propertyIds: ["a", "b"] }]);

    sockets[0].emitMessage({ op: "value", propertyId: "a", envelope: { value: 42 } });
    expect(values).toEqual([["a", { value: 42 }]]);
  });

  it("replays the full subscribe set after a reconnect", async () => {
    const { sockets, client } = makeHarness();
    clients.push(client);

    sockets[0].emitOpen();
    client.subscribe(["a"]);
    client.subscribe(["b"]);
    client.unsubscribe(["a"]);

    sockets[0].emitClose();
    await waitFor(() => sockets.length >= 2);
    sockets[1].emitOpen();

    expect(sockets[1].sent).toEqual([{ op: "subscribe", propertyIds: ["b"] }]);
  });

  it("queues subscriptions made while disconnected and sends them on connect", async () => {
    const { sockets, client } = makeHarness();
    clients.push(client);

    client.subscribe(["a"]); // socket 0 still CONNECTING — nothing sent yet
    expect(sockets[0].sent).toEqual([]);

    sockets[0].emitOpen();
    expect(sockets[0].sent).toEqual([{ op: "subscribe", propertyIds: ["a"] }]);
  });

  it("stops reconnecting after close()", async () => {
    const { sockets, client } = makeHarness();
    clients.push(client);

    sockets[0].emitOpen();
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sockets).toHaveLength(1);
  });
});

describe("ReconnectingGraphSocket auth", () => {
  it("sends auth first and defers subscribes until ready", async () => {
    const { sockets, client } = makeHarness(() => {}, { getToken: () => "token-1" });
    clients.push(client);

    client.subscribe(["a"]);
    sockets[0].emitOpen();
    await waitFor(() => sockets[0].sent.length >= 1);
    expect(sockets[0].sent).toEqual([{ op: "auth", token: "token-1" }]);

    // Subscribes made before ready stay queued.
    client.subscribe(["b"]);
    expect(sockets[0].sent).toHaveLength(1);

    sockets[0].emitMessage({ op: "ready", siteId: "site-1", authExpiresAt: null });
    expect(sockets[0].sent[1]).toEqual({ op: "subscribe", propertyIds: ["a", "b"] });
  });

  it("re-auths with a fresh token on auth_expiring", async () => {
    let calls = 0;
    const { sockets, client } = makeHarness(() => {}, { getToken: () => `token-${++calls}` });
    clients.push(client);

    sockets[0].emitOpen();
    await waitFor(() => sockets[0].sent.length >= 1);
    sockets[0].emitMessage({ op: "ready" });

    sockets[0].emitMessage({ op: "auth_expiring" });
    await waitFor(() => sockets[0].sent.length >= 2);
    expect(sockets[0].sent[1]).toEqual({ op: "auth", token: "token-2" });
  });

  it("reconnects with a fresh token and replays subscriptions after a 4401 close", async () => {
    let calls = 0;
    const { sockets, client } = makeHarness(() => {}, { getToken: () => `token-${++calls}` });
    clients.push(client);

    sockets[0].emitOpen();
    await waitFor(() => sockets[0].sent.length >= 1);
    sockets[0].emitMessage({ op: "ready" });
    client.subscribe(["a"]);

    sockets[0].emitClose(4401);
    await waitFor(() => sockets.length >= 2);
    sockets[1].emitOpen();
    await waitFor(() => sockets[1].sent.length >= 1);
    expect(sockets[1].sent[0]).toEqual({ op: "auth", token: "token-2" });

    sockets[1].emitMessage({ op: "ready" });
    expect(sockets[1].sent[1]).toEqual({ op: "subscribe", propertyIds: ["a"] });
  });

  it("surfaces error codes to onError", () => {
    const errors: Array<[string, string | undefined]> = [];
    const sockets: FakeSocket[] = [];
    const client = new ReconnectingGraphSocket({
      url: "ws://test/ws/graph",
      onValue: () => {},
      onError: (error, code) => errors.push([error, code]),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    clients.push(client);

    sockets[0].emitOpen();
    sockets[0].emitMessage({ op: "error", error: "forbidden", code: "FORBIDDEN", propertyIds: ["x"] });
    expect(errors).toEqual([["forbidden", "FORBIDDEN"]]);
  });
});
