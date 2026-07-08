import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import { parseEnvelopeText } from "../value/cvg-store.js";
import type { GraphRuntime } from "../engine/runtime.js";
import type { LivestoreLogger } from "../value/types.js";

interface WsLike {
  readyState: number;
  bufferedAmount: number;
  send: (data: string) => void;
  close: () => void;
  ping: () => void;
  terminate: () => void;
  on(event: "message", handler: (data: unknown) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: unknown) => void): void;
  on(event: "pong", handler: () => void): void;
}

const OPEN = 1;

// Backpressure threshold for websocket sends
const HIGH_WATER_MARK = 1_000_000;

// Client messages are subscribe/unsubscribe lists; anything near this size is abuse.
const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface GraphSocketOptions {
  /** Interval between server pings; a connection missing `maxMissedPongs` pongs is terminated. */
  heartbeatIntervalMs?: number;
  maxMissedPongs?: number;
  /** Maximum concurrent KV watchers (subscribed properties) per connection. */
  maxWatchersPerConnection?: number;
  /** Maximum propertyIds accepted in a single subscribe/unsubscribe message. */
  maxPropertyIdsPerMessage?: number;
  /** Token bucket for client ops: sustained rate and burst capacity. */
  opsPerSecond?: number;
  opsBurst?: number;
}

const DEFAULT_SOCKET_OPTIONS: Required<GraphSocketOptions> = {
  heartbeatIntervalMs: 30_000,
  maxMissedPongs: 2,
  maxWatchersPerConnection: 1_000,
  maxPropertyIdsPerMessage: 1_000,
  opsPerSecond: 10,
  opsBurst: 30,
};

// Create the Fastify app first so the engine can log through its Pino instance (see asLivestoreLogger).
export async function createLivestoreServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: true });
  await server.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });
  await server.register(websocket, { options: { maxPayload: MAX_PAYLOAD_BYTES } });
  return server;
}

// Fastify's logger is a Pino instance whose signature already matches ours.
export function asLivestoreLogger(server: FastifyInstance): LivestoreLogger {
  return server.log as unknown as LivestoreLogger;
}

export function registerGraphRoutes(
  server: FastifyInstance,
  runtime: GraphRuntime,
  socketOptions?: GraphSocketOptions,
): void {
  const opts = { ...DEFAULT_SOCKET_OPTIONS, ...socketOptions };
  server.get("/health", async () => ({
    status: runtime.isReady() ? "ok" : "starting",
    ...runtime.counts(),
  }));

  server.get("/healthz", async () => ({ ok: true, service: "livestore" }));

  server.get("/readyz", async (_request, reply) => {
    const ready = runtime.isReady();
    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      service: "livestore",
      ...runtime.counts(),
    });
  });

  server.get("/graph/nodes", async () => ({ data: runtime.listNodes() }));

  server.get<{ Params: { id: string } }>("/graph/nodes/:id", async (request, reply) => {
    const node = runtime.getNode(request.params.id);
    if (!node) return reply.code(404).send({ error: "Graph node not found" });
    return node;
  });

  server.get("/ws/graph", { websocket: true }, (socket, _request) => {
    const ws = socket as WsLike;
    const watchers = new Map<string, { stop: () => void }>();

    // Heartbeat: terminate connections whose peer stops answering pings, so
    // half-open sockets don't leak KV watchers indefinitely.
    let missedPongs = 0;
    ws.on("pong", () => {
      missedPongs = 0;
    });
    const heartbeatTimer = setInterval(() => {
      if (ws.readyState !== OPEN) return;
      if (missedPongs >= opts.maxMissedPongs) {
        server.log.warn("livestore websocket missed pongs, terminating");
        ws.terminate();
        return;
      }
      missedPongs += 1;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, opts.heartbeatIntervalMs);

    // Token bucket for client ops (subscribe/unsubscribe).
    let opTokens = opts.opsBurst;
    let lastRefill = Date.now();
    const takeOpToken = (): boolean => {
      const now = Date.now();
      opTokens = Math.min(opts.opsBurst, opTokens + ((now - lastRefill) / 1000) * opts.opsPerSecond);
      lastRefill = now;
      if (opTokens < 1) return false;
      opTokens -= 1;
      return true;
    };

    // lates wins per property to avoid backpressure
    const pending = new Map<string, unknown>();
    let drainTimer: ReturnType<typeof setInterval> | null = null;

    const sendJson = (payload: unknown) => {
      if (ws.readyState !== OPEN) return;
      ws.send(JSON.stringify(payload));
    };

    const clearDrainTimer = () => {
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
    };

    // Flush queued updates while under the high-water mark; retry the rest on a short timer (§9.3).
    const flushPending = () => {
      if (ws.readyState !== OPEN) {
        pending.clear();
        clearDrainTimer();
        return;
      }
      for (const [propertyId, envelope] of pending) {
        if (ws.bufferedAmount > HIGH_WATER_MARK) break;
        pending.delete(propertyId);
        ws.send(JSON.stringify({ op: "value", propertyId, envelope }));
      }
      if (pending.size > 0) {
        if (!drainTimer) drainTimer = setInterval(flushPending, 50);
      } else {
        clearDrainTimer();
      }
    };

    const sendValue = (propertyId: string, envelope: unknown) => {
      if (ws.readyState !== OPEN) return;
      pending.set(propertyId, envelope);
      flushPending();
    };

    const stopWatcher = (propertyId: string) => {
      watchers.get(propertyId)?.stop();
      watchers.delete(propertyId);
    };

    const stopAll = () => {
      for (const propertyId of watchers.keys()) stopWatcher(propertyId);
      pending.clear();
      clearDrainTimer();
      clearInterval(heartbeatTimer);
    };

    const subscribe = async (propertyIds: string[]) => {
      for (const propertyId of propertyIds) {
        if (watchers.has(propertyId)) continue;
        if (watchers.size >= opts.maxWatchersPerConnection) {
          sendJson({ op: "error", error: "subscription limit reached" });
          return;
        }

        const initial = (await runtime.getCvgValue(propertyId)) ?? runtime.getCurrentOrStale(propertyId);
        sendValue(propertyId, initial);

        const watcher = await runtime.watchCvgValue(propertyId);
        watchers.set(propertyId, { stop: () => watcher.stop() });
        void (async () => {
          try {
            for await (const entry of watcher) {
              const envelope = parseEnvelopeText(entry.string());
              if (!envelope) continue;
              sendValue(propertyId, envelope);
            }
          } catch (err) {
            server.log.warn({ err, propertyId }, "livestore websocket KV watcher stopped");
          } finally {
            watchers.delete(propertyId);
          }
        })();
      }
    };

    ws.on("message", (raw) => {
      void (async () => {
        if (!takeOpToken()) {
          sendJson({ op: "error", error: "rate limited" });
          return;
        }

        const message = parseClientMessage(raw, opts.maxPropertyIdsPerMessage);
        if (!message) {
          sendJson({ op: "error", error: "invalid message" });
          return;
        }

        if (message.op === "subscribe") {
          await subscribe(message.propertyIds);
          return;
        }

        if (message.op === "unsubscribe") {
          for (const propertyId of message.propertyIds) stopWatcher(propertyId);
          return;
        }

        sendJson({ op: "error", error: "unsupported op" });
      })().catch((err) => {
        server.log.warn({ err }, "livestore websocket message failed");
        sendJson({ op: "error", error: "message failed" });
      });
    });

    ws.on("close", stopAll);
    ws.on("error", (err) => {
      server.log.warn({ err }, "livestore websocket error");
      stopAll();
    });
  });
}

type ClientMessage = { op: "subscribe" | "unsubscribe"; propertyIds: string[] };

function parseClientMessage(raw: unknown, maxPropertyIds: number): ClientMessage | null {
  try {
    const parsed = JSON.parse(rawToString(raw)) as unknown;
    if (!isClientMessage(parsed)) return null;
    if (parsed.propertyIds.length > maxPropertyIds) return null;
    return parsed;
  } catch {
    return null;
  }
}

function rawToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  return String(raw);
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { op?: unknown; propertyIds?: unknown };
  if (message.op !== "subscribe" && message.op !== "unsubscribe") return false;
  return (
    Array.isArray(message.propertyIds) && message.propertyIds.every((propertyId) => typeof propertyId === "string")
  );
}
