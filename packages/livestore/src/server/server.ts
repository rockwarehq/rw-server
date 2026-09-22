import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { deriveUiChangeSubject, parseUiChangeEvent } from "@rw/runtime/ui-change-events";

import type { GraphRuntime } from "../engine/runtime.js";
import type { LivestoreLogger, ValueEnvelope } from "../types/index.js";
import { bearerFromAuthorizationHeader, type LivestorePrincipal } from "./auth.js";
import { PublishedGraphAccess } from "../graph/read-scope.js";
import { canReadMetricEntity } from "@rw/services/entity/access-scope";

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
    const nodes = runtime.listNodesForSite(principal.siteId);
    if (principal.kind !== "user") return { data: nodes };
    const access = new PublishedGraphAccess(principal.readScope);
    const visible = await Promise.all(nodes.map((node) => access.node(node)));
    return { data: visible.filter((node) => node !== null) };
  });

  server.get<{ Params: { id: string } }>("/graph/nodes/:id", async (request, reply) => {
    const principal = await requirePrincipal(request, reply);
    if (!principal) return reply;
    const node = runtime.getNode(request.params.id);
    // Cross-site nodes 404 (not 403) so probing can't confirm existence.
    if (!node || node.siteId !== principal.siteId) {
      return reply.code(404).send({ error: "Graph node not found" });
    }
    if (principal.kind !== "user") return node;
    const visible = await new PublishedGraphAccess(principal.readScope).node(node);
    return visible ?? reply.code(404).send({ error: "Graph node not found" });
  });

  const graphSocketHandler = (socket: unknown, request: FastifyRequest) => {
    const ws = socket as WsLike;
    const watchers = new Map<string, { stop: () => void }>();
    // UI change pings (ui.changes.<site>): one relay per connection, opted into by the client.
    let stopChanges: (() => void) | null = null;

    // ---- Authentication state -------------------------------------------
    // Server clients authenticate via the Authorization header on the upgrade
    // request; browsers (which can't set WS headers) send {op:"auth", token}
    // as their first message within authTimeoutMs.
    let principal: LivestorePrincipal | null = null;
    let appToken: string | null = null; // retained for periodic revalidation
    let userToken: string | null = null;
    let access: PublishedGraphAccess | null = null;
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
      principal = null;
      access = null;
      pending.clear();
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

    const scheduleUserRevalidation = () => {
      revalidateTimer = setInterval(
        () => {
          if (!userToken || principal?.kind !== "user") return;
          const previous = principal;
          void authenticator
            .authenticate(userToken)
            .then((next) => {
              if (
                !next ||
                next.kind !== "user" ||
                next.userId !== previous.userId ||
                JSON.stringify(next.readScope) !== JSON.stringify(previous.readScope)
              ) {
                closeUnauthorized("AUTH_EXPIRED", "membership or read scope changed");
              } else if (principal === previous) {
                access?.invalidate();
                pending.clear();
                principal = next;
                access = new PublishedGraphAccess(next.readScope);
              }
            })
            .catch(() => closeUnauthorized("AUTH_EXPIRED", "unable to revalidate membership"));
        },
        Math.min(opts.appRevalidateIntervalMs, 30_000),
      );
    };

    // Adopt (or replace, on re-auth) the connection's principal and reset the
    // lifecycle timers that go with it.
    const applyPrincipal = (next: LivestorePrincipal) => {
      clearAuthTimers();
      access?.invalidate();
      principal = next;
      access = next.kind === "user" ? new PublishedGraphAccess(next.readScope) : null;
      if (next.expMs !== null) scheduleJwtExpiry(next.expMs);
      if (next.kind === "app") scheduleAppRevalidation();
      if (next.kind === "user") scheduleUserRevalidation();
      sendJson({
        op: "ready",
        siteId: next.siteId,
        authExpiresAt: next.expMs,
        scope: {
          siteId: next.siteId,
          workspaceId: next.workspaceId,
          ...(next.kind === "user" ? { workcenterIds: next.readScope.workcenterIds } : {}),
        },
      });
    };

    const handleAuthMessage = async (token: string) => {
      const next = await authenticator.authenticate(token);
      if (!next) {
        closeUnauthorized("UNAUTHORIZED", "unauthorized");
        return;
      }
      // Re-auth may refresh credentials but not move the connection to
      // another tenant; existing subscriptions were authorized per-site.
      if (principal && (next.siteId !== principal.siteId || next.workspaceId !== principal.workspaceId)) {
        sendJson({ op: "error", error: "site mismatch", code: "SITE_MISMATCH" });
        return;
      }
      appToken = next.kind === "app" ? token : null;
      userToken = next.kind === "user" ? token : null;
      // Refresh may change grants or identity. Discard authorized-under-old-scope watchers.
      if (principal && JSON.stringify(principal) !== JSON.stringify(next)) {
        for (const id of watchers.keys()) stopWatcher(id);
        pending.clear();
      }
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
    const pending = new Map<string, ValueEnvelope>();
    // Highest timestamp sent per property: the initial read can serve a queued
    // write-behind value newer than the KV watcher's first delivery, and the
    // client must never see the older one after it.
    const lastSentTs = new Map<string, number>();
    let drainTimer: ReturnType<typeof setInterval> | null = null;
    let draining = false;

    const clearDrainTimer = () => {
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
    };

    // Flush queued updates while under the high-water mark; retry the rest on a short timer (§9.3).
    const flushPending = async () => {
      if (draining) return;
      if (ws.readyState !== OPEN) {
        pending.clear();
        clearDrainTimer();
        return;
      }
      draining = true;
      try {
        for (const [propertyId, envelope] of pending) {
          if (ws.bufferedAmount > HIGH_WATER_MARK) break;
          const checkedPrincipal = principal;
          const checkedAccess = access;
          let allowed = !!checkedPrincipal;
          try {
            // A buffered value may outlive the proof TTL. Recheck at actual
            // delivery; memoized ownership avoids new queries on the hot path.
            if (allowed && checkedAccess)
              allowed = await checkedAccess.property(propertyId, new Set(), envelope.timestamp);
          } catch {
            allowed = false;
          }
          if (pending.get(propertyId) !== envelope) continue;
          pending.delete(propertyId);
          if (allowed && principal === checkedPrincipal && access === checkedAccess && ws.readyState === OPEN) {
            ws.send(JSON.stringify({ op: "value", propertyId, envelope }));
          }
        }
      } finally {
        draining = false;
        if (pending.size > 0) {
          if (!drainTimer) drainTimer = setInterval(() => void flushPending(), 50);
        } else {
          clearDrainTimer();
        }
      }
    };

    const sendValue = (propertyId: string, envelope: ValueEnvelope) => {
      if (ws.readyState !== OPEN || !principal) return;
      const last = lastSentTs.get(propertyId);
      if (last !== undefined && envelope.timestamp < last) return;
      lastSentTs.set(propertyId, envelope.timestamp);
      pending.set(propertyId, envelope);
      void flushPending();
    };

    const stopWatcher = (propertyId: string) => {
      watchers.get(propertyId)?.stop();
      watchers.delete(propertyId);
      pending.delete(propertyId);
      lastSentTs.delete(propertyId);
    };

    let closed = false;
    const stopAll = () => {
      closed = true;
      stopChanges?.();
      stopChanges = null;
      for (const propertyId of watchers.keys()) stopWatcher(propertyId);
      pending.clear();
      lastSentTs.clear();
      clearDrainTimer();
      clearInterval(heartbeatTimer);
      clearAuthTimers();
    };

    const subscribe = async (propertyIds: string[]) => {
      for (const propertyId of propertyIds) {
        // Re-check after every await: close can land mid-subscribe, and a
        // listener registered after stopAll would leak untracked.
        if (closed) return;
        if (watchers.has(propertyId)) continue;
        if (watchers.size >= opts.maxWatchersPerConnection) {
          sendJson({ op: "error", error: "subscription limit reached", code: "SUBSCRIPTION_LIMIT" });
          return;
        }

        // Register the in-process listener BEFORE reading the initial value, so
        // a commit racing the async read isn't missed; the monotonic lastSentTs
        // guard in sendValue resolves ordering between the two.
        const deliver = async (envelope: ValueEnvelope) => {
          const checkedPrincipal = principal;
          const checkedAccess = access;
          if (!checkedPrincipal) return;
          if (checkedAccess && !(await checkedAccess.property(propertyId, new Set(), envelope.timestamp))) return;
          if (principal !== checkedPrincipal || access !== checkedAccess || !watchers.has(propertyId)) return;
          sendValue(propertyId, envelope);
        };
        const unsubscribe = runtime.subscribeToProperty(propertyId, (envelope) => {
          void deliver(envelope).catch(() => {});
        });
        watchers.set(propertyId, { stop: unsubscribe });

        const initial = (await runtime.getCvgValue(propertyId)) ?? runtime.getCurrentOrStale(propertyId);
        if (closed) {
          stopWatcher(propertyId);
          return;
        }
        await deliver(initial);
      }
    };

    // Messages are handled strictly in order on a per-connection chain:
    // concurrent subscribe tasks would race the watchers map and its cap
    // (duplicate/leaked KV watchers) across the awaits inside subscribe.
    let messageChain: Promise<void> = Promise.resolve();
    ws.on("message", (raw) => {
      const run = async () => {
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
            const readable =
              runtime.getPropertySiteId(propertyId) === siteId && (!access || (await access.property(propertyId)));
            (readable ? allowed : rejected).push(propertyId);
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

        if (message.op === "subscribe-changes") {
          // Ownership changes invalidate cached proofs even if their UI ping is suppressed.
          stopChanges ??= runtime.subscribeSubject(deriveUiChangeSubject(principal.siteId), (data) => {
            let event = null;
            try {
              event = parseUiChangeEvent(JSON.parse(changeDecoder.decode(data)));
            } catch {
              return;
            }
            if (!event || !principal || event.siteId !== principal.siteId) return;
            access?.invalidate();
            pending.clear();
            if (principal.kind !== "user") {
              sendJson({ op: "change", event });
              return;
            }
            const checkedPrincipal = principal;
            const readScope = checkedPrincipal.readScope;
            if (!event.stationId) {
              if (readScope.workcenterIds === undefined) sendJson({ op: "change", event });
              return;
            }
            void canReadMetricEntity(readScope, { entityType: "STATION", entityId: event.stationId })
              .then((ok) => {
                if (ok && principal === checkedPrincipal) sendJson({ op: "change", event });
              })
              .catch(() => {});
          });
          return;
        }

        sendJson({ op: "error", error: "unsupported op", code: "INVALID_MESSAGE" });
      };
      messageChain = messageChain.then(run).catch((err) => {
        server.log.warn({ err }, "livestore websocket message failed");
        sendJson({ op: "error", error: "message failed", code: "INTERNAL" });
      });
    });

    ws.on("close", stopAll);
    ws.on("error", (err) => {
      server.log.warn({ err }, "livestore websocket error");
      stopAll();
    });
  };

  server.get("/graph/live", { websocket: true }, graphSocketHandler);

  // Deprecated alias for clients that predate /graph/live; the warning keeps
  // remaining traffic visible so the alias can eventually be removed.
  server.get("/ws/graph", { websocket: true }, (socket, request) => {
    server.log.warn("deprecated /ws/graph endpoint used; migrate to /graph/live");
    graphSocketHandler(socket, request);
  });
}

type ClientMessage =
  | { op: "subscribe" | "unsubscribe"; propertyIds: string[] }
  | { op: "auth"; token: string }
  | { op: "subscribe-changes" };

const changeDecoder = new TextDecoder();

function parseClientMessage(raw: unknown, maxPropertyIds: number): ClientMessage | null {
  try {
    const parsed = JSON.parse(rawToString(raw)) as unknown;
    if (!isClientMessage(parsed)) return null;
    if ("propertyIds" in parsed && parsed.propertyIds.length > maxPropertyIds) return null;
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
  if (message.op === "subscribe-changes") return true;
  if (message.op !== "subscribe" && message.op !== "unsubscribe") return false;
  return (
    Array.isArray(message.propertyIds) && message.propertyIds.every((propertyId) => typeof propertyId === "string")
  );
}
