import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { parseEnvelopeText } from "../value/cvg-store.js";
import type { GraphRuntime } from "../engine/runtime.js";
import type { LivestoreLogger } from "../value/types.js";
import { bearerFromAuthorizationHeader, type LivestorePrincipal } from "./auth.js";

// Structural so tests (and future transports) can stub it; LivestoreAuthenticator
// in ./auth.js is the production implementation.
export interface GraphAuthenticator {
  authenticate(bearer: string): Promise<LivestorePrincipal | null>;
  revalidateApiToken(token: string): Promise<boolean>;
}

interface WsLike {
  readyState: number;
  bufferedAmount: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
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

// Application close code for authentication failures (4000-range is reserved
// for applications; clients treat it as "get a fresh token, then reconnect").
const CLOSE_UNAUTHORIZED = 4401;

// Lead time before token expiry at which the server nudges the client to
// re-auth with a refreshed token.
const AUTH_EXPIRY_WARN_MS = 60_000;

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
  /** How long an un-authenticated connection may live before it is closed. */
  authTimeoutMs?: number;
  /** Grace period past JWT expiry before the connection is closed (client is warned at exp - 60s). */
  authExpiryGraceMs?: number;
  /** How often app (API token) principals are re-validated against the DB/cache. */
  appRevalidateIntervalMs?: number;
}

const DEFAULT_SOCKET_OPTIONS: Required<GraphSocketOptions> = {
  heartbeatIntervalMs: 30_000,
  maxMissedPongs: 2,
  maxWatchersPerConnection: 1_000,
  maxPropertyIdsPerMessage: 1_000,
  opsPerSecond: 10,
  opsBurst: 30,
  authTimeoutMs: 10_000,
  authExpiryGraceMs: 60_000,
  appRevalidateIntervalMs: 60_000,
};

// Create the Fastify app first so the engine can log through its Pino instance (see asLivestoreLogger).
export async function createLivestoreServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: true });
  // Wildcard CORS is deliberate: customer apps live on arbitrary origins, and
  // every credential here is an explicit Authorization header (no cookies), so
  // there is no ambient authority for a foreign origin to ride.
  await server.register(cors, {
    origin: "*",
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
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
  authenticator: GraphAuthenticator,
  socketOptions?: GraphSocketOptions,
): void {
  const opts = { ...DEFAULT_SOCKET_OPTIONS, ...socketOptions };

  // Public probes carry no graph shape information; counts live on the
  // private metrics listener.
  server.get("/health", async () => ({
    status: runtime.isReady() ? "ok" : "starting",
  }));

  server.get("/healthz", async () => ({ ok: true, service: "livestore" }));

  server.get("/readyz", async (_request, reply) => {
    const ready = runtime.isReady();
    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      service: "livestore",
    });
  });

  // Single generic 401 for missing/expired/malformed credentials; the
  // authenticator logs the distinction server-side.
  const requirePrincipal = async (request: FastifyRequest, reply: FastifyReply): Promise<LivestorePrincipal | null> => {
    const bearer = bearerFromAuthorizationHeader(request.headers.authorization);
    const principal = bearer ? await authenticator.authenticate(bearer) : null;
    if (!principal) {
      await reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return principal;
  };

  server.get("/graph/nodes", async (request, reply) => {
    const principal = await requirePrincipal(request, reply);
    if (!principal) return reply;
    return { data: runtime.listNodesForSite(principal.siteId) };
  });

  server.get<{ Params: { id: string } }>("/graph/nodes/:id", async (request, reply) => {
    const principal = await requirePrincipal(request, reply);
    if (!principal) return reply;
    const node = runtime.getNode(request.params.id);
    // Cross-site nodes 404 (not 403) so probing can't confirm existence.
    if (!node || node.siteId !== principal.siteId) {
      return reply.code(404).send({ error: "Graph node not found" });
    }
    return node;
  });

  server.get("/ws/graph", { websocket: true }, (socket, request) => {
    const ws = socket as WsLike;
    const watchers = new Map<string, { stop: () => void }>();

    // ---- Authentication state -------------------------------------------
    // Server clients authenticate via the Authorization header on the upgrade
    // request; browsers (which can't set WS headers) send {op:"auth", token}
    // as their first message within authTimeoutMs.
    let principal: LivestorePrincipal | null = null;
    let appToken: string | null = null; // retained for periodic revalidation
    let authTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryWarnTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let revalidateTimer: ReturnType<typeof setInterval> | null = null;

    const clearAuthTimers = () => {
      if (authTimer) clearTimeout(authTimer);
      if (expiryWarnTimer) clearTimeout(expiryWarnTimer);
      if (expiryCloseTimer) clearTimeout(expiryCloseTimer);
      if (revalidateTimer) clearInterval(revalidateTimer);
      authTimer = expiryWarnTimer = expiryCloseTimer = null;
      revalidateTimer = null;
    };

    const sendJson = (payload: unknown) => {
      if (ws.readyState !== OPEN) return;
      ws.send(JSON.stringify(payload));
    };

    const closeUnauthorized = (code: string, error: string) => {
      sendJson({ op: "error", error, code });
      ws.close(CLOSE_UNAUTHORIZED, error);
    };

    const scheduleJwtExpiry = (expMs: number) => {
      const warnIn = Math.max(0, expMs - AUTH_EXPIRY_WARN_MS - Date.now());
      expiryWarnTimer = setTimeout(() => sendJson({ op: "auth_expiring" }), warnIn);
      const closeIn = Math.max(0, expMs + opts.authExpiryGraceMs - Date.now());
      expiryCloseTimer = setTimeout(() => closeUnauthorized("AUTH_EXPIRED", "authentication expired"), closeIn);
    };

    const scheduleAppRevalidation = () => {
      revalidateTimer = setInterval(() => {
        if (!appToken) return;
        void authenticator
          .revalidateApiToken(appToken)
          .then((ok) => {
            if (!ok) closeUnauthorized("AUTH_EXPIRED", "token revoked or expired");
          })
          .catch(() => {});
      }, opts.appRevalidateIntervalMs);
    };

    // Adopt (or replace, on re-auth) the connection's principal and reset the
    // lifecycle timers that go with it.
    const applyPrincipal = (next: LivestorePrincipal) => {
      clearAuthTimers();
      principal = next;
      if (next.expMs !== null) scheduleJwtExpiry(next.expMs);
      if (next.kind === "app") scheduleAppRevalidation();
      sendJson({ op: "ready", siteId: next.siteId, authExpiresAt: next.expMs });
    };

    const handleAuthMessage = async (token: string) => {
      const next = await authenticator.authenticate(token);
      if (!next) {
        closeUnauthorized("UNAUTHORIZED", "unauthorized");
        return;
      }
      // Re-auth may refresh credentials but not move the connection to
      // another tenant; existing subscriptions were authorized per-site.
      if (principal && next.siteId !== principal.siteId) {
        sendJson({ op: "error", error: "site mismatch", code: "SITE_MISMATCH" });
        return;
      }
      appToken = next.kind === "app" ? token : null;
      applyPrincipal(next);
    };

    const headerBearer = bearerFromAuthorizationHeader(request.headers.authorization);
    const initialAuth: Promise<void> = headerBearer
      ? handleAuthMessage(headerBearer)
      : Promise.resolve().then(() => {
          authTimer = setTimeout(() => closeUnauthorized("UNAUTHORIZED", "authentication timeout"), opts.authTimeoutMs);
        });

    // ---- Heartbeat -------------------------------------------------------
    // Terminate connections whose peer stops answering pings, so half-open
    // sockets don't leak KV watchers indefinitely.
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

    // Token bucket for client ops (auth/subscribe/unsubscribe).
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
      clearAuthTimers();
    };

    const subscribe = async (propertyIds: string[]) => {
      for (const propertyId of propertyIds) {
        if (watchers.has(propertyId)) continue;
        if (watchers.size >= opts.maxWatchersPerConnection) {
          sendJson({ op: "error", error: "subscription limit reached", code: "SUBSCRIPTION_LIMIT" });
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
        // Settle in-flight header authentication before judging auth state.
        await initialAuth;

        if (!takeOpToken()) {
          sendJson({ op: "error", error: "rate limited", code: "RATE_LIMITED" });
          return;
        }

        const message = parseClientMessage(raw, opts.maxPropertyIdsPerMessage);
        if (!message) {
          sendJson({ op: "error", error: "invalid message", code: "INVALID_MESSAGE" });
          return;
        }

        if (message.op === "auth") {
          await handleAuthMessage(message.token);
          return;
        }

        if (!principal) {
          closeUnauthorized("UNAUTHORIZED", "unauthorized");
          return;
        }

        if (message.op === "subscribe") {
          // Per-subscription tenancy check: unknown and cross-site ids are
          // rejected identically (no existence oracle).
          const siteId = principal.siteId;
          const allowed: string[] = [];
          const rejected: string[] = [];
          for (const propertyId of message.propertyIds) {
            (runtime.getPropertySiteId(propertyId) === siteId ? allowed : rejected).push(propertyId);
          }
          if (rejected.length > 0) {
            sendJson({ op: "error", error: "forbidden", code: "FORBIDDEN", propertyIds: rejected });
          }
          if (allowed.length > 0) await subscribe(allowed);
          return;
        }

        if (message.op === "unsubscribe") {
          for (const propertyId of message.propertyIds) stopWatcher(propertyId);
          return;
        }

        sendJson({ op: "error", error: "unsupported op", code: "INVALID_MESSAGE" });
      })().catch((err) => {
        server.log.warn({ err }, "livestore websocket message failed");
        sendJson({ op: "error", error: "message failed", code: "INTERNAL" });
      });
    });

    ws.on("close", stopAll);
    ws.on("error", (err) => {
      server.log.warn({ err }, "livestore websocket error");
      stopAll();
    });
  });
}

type ClientMessage = { op: "subscribe" | "unsubscribe"; propertyIds: string[] } | { op: "auth"; token: string };

function parseClientMessage(raw: unknown, maxPropertyIds: number): ClientMessage | null {
  try {
    const parsed = JSON.parse(rawToString(raw)) as unknown;
    if (!isClientMessage(parsed)) return null;
    if (parsed.op !== "auth" && parsed.propertyIds.length > maxPropertyIds) return null;
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
  const message = value as { op?: unknown; propertyIds?: unknown; token?: unknown };
  if (message.op === "auth") return typeof message.token === "string" && message.token.length > 0;
  if (message.op !== "subscribe" && message.op !== "unsubscribe") return false;
  return (
    Array.isArray(message.propertyIds) && message.propertyIds.every((propertyId) => typeof propertyId === "string")
  );
}
