// Browser-safe reconnecting client for the livestore /graph/live endpoint.
// No server imports here — dashboards deep-import this via "@rw/livestore/client/*".

export type GraphSocketState = "connecting" | "open" | "closed";

export interface GraphSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: (event: { code?: number }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface ReconnectingGraphSocketOptions {
  url: string;
  onValue: (propertyId: string, envelope: unknown) => void;
  onError?: (error: string, code?: string) => void;
  onStateChange?: (state: GraphSocketState) => void;
  /**
   * Access credential for the socket: a user/display access JWT or an
   * rw_app_ API token. Called on every (re)connect and whenever the server
   * signals the current token is about to expire, so return a fresh token
   * (e.g. from your refresh flow) each time. When set, the client sends
   * {op:"auth"} as its first message and defers subscribes until the server
   * acks with {op:"ready"}.
   */
  getToken?: () => string | Promise<string>;
  /** Defaults to globalThis.WebSocket; override for Node or tests. */
  webSocketFactory?: (url: string) => GraphSocketLike;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const WS_OPEN = 1;

// Server closes with this code for any authentication failure; the client
// fetches a fresh token and reconnects.
const CLOSE_UNAUTHORIZED = 4401;

/**
 * Maintains a desired subscription set across connection drops: on every
 * (re)connect it authenticates (when getToken is set), then replays a
 * subscribe for the full set once the server acks ready, so a reconnect
 * fully recovers state.
 */
export class ReconnectingGraphSocket {
  private readonly options: ReconnectingGraphSocketOptions;
  private readonly desired = new Set<string>();
  private ws: GraphSocketLike | null = null;
  private ready = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(options: ReconnectingGraphSocketOptions) {
    this.options = options;
    this.connect();
  }

  subscribe(propertyIds: string[]): void {
    const fresh = propertyIds.filter((id) => !this.desired.has(id));
    for (const id of fresh) this.desired.add(id);
    if (fresh.length > 0) this.sendOp("subscribe", fresh);
  }

  unsubscribe(propertyIds: string[]): void {
    const removed = propertyIds.filter((id) => this.desired.delete(id));
    if (removed.length > 0) this.sendOp("unsubscribe", removed);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.options.onStateChange?.("closed");
  }

  // Subscribes are held back until the connection can accept them: socket
  // open, and (when authenticating) the server's ready ack received.
  private canSend(): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return false;
    return this.options.getToken ? this.ready : true;
  }

  private sendOp(op: "subscribe" | "unsubscribe", propertyIds: string[]): void {
    if (this.canSend()) {
      this.ws?.send(JSON.stringify({ op, propertyIds }));
    }
    // Not sendable: the desired set is replayed once the connection is ready.
  }

  private replayDesired(ws: GraphSocketLike): void {
    if (this.desired.size > 0) {
      ws.send(JSON.stringify({ op: "subscribe", propertyIds: [...this.desired] }));
    }
  }

  private async sendAuth(ws: GraphSocketLike): Promise<void> {
    if (!this.options.getToken) return;
    try {
      const token = await this.options.getToken();
      if (this.ws === ws && ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify({ op: "auth", token }));
      }
    } catch {
      // Token fetch failed; the server's auth timeout will close the socket
      // and the normal backoff reconnect takes over.
    }
  }

  private connect(): void {
    if (this.closedByUser) return;
    this.options.onStateChange?.("connecting");

    const factory =
      this.options.webSocketFactory ??
      ((url: string) => new (globalThis as { WebSocket: new (url: string) => GraphSocketLike }).WebSocket(url));
    let ws: GraphSocketLike;
    try {
      ws = factory(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.ready = false;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.options.onStateChange?.("open");
      if (this.options.getToken) {
        // Authenticate first; the desired set replays on the ready ack.
        void this.sendAuth(ws);
      } else {
        this.replayDesired(ws);
      }
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.op === "value") {
        this.options.onValue(message.propertyId, message.envelope);
      } else if (message.op === "ready") {
        const firstReady = !this.ready;
        this.ready = true;
        if (firstReady) this.replayDesired(ws);
      } else if (message.op === "auth_expiring") {
        // Server nudge: current credential is near expiry — re-auth in place
        // with a fresh token instead of riding into the disconnect.
        void this.sendAuth(ws);
      } else if (message.op === "error") {
        this.options.onError?.(message.error, message.code);
      }
    });

    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      // 4401 means the credential was rejected/expired; getToken is consulted
      // again on the reconnect, which picks up a refreshed token.
      if (event?.code === CLOSE_UNAUTHORIZED) this.attempt = Math.max(this.attempt, 1);
      this.scheduleReconnect();
    });

    // "error" is always followed by "close"; reconnect is handled there.
    ws.addEventListener("error", () => {});
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const initial = this.options.initialBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 30_000;
    // Full jitter: uniform over [0, min(max, initial * 2^attempt)].
    const delay = Math.random() * Math.min(max, initial * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

type ServerMessage =
  | { op: "value"; propertyId: string; envelope: unknown }
  | { op: "ready"; siteId?: string; authExpiresAt?: number | null }
  | { op: "auth_expiring" }
  | { op: "error"; error: string; code?: string };

function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as {
      op?: unknown;
      propertyId?: unknown;
      error?: unknown;
      envelope?: unknown;
      siteId?: unknown;
      authExpiresAt?: unknown;
      code?: unknown;
    };
    if (parsed.op === "value" && typeof parsed.propertyId === "string") {
      return { op: "value", propertyId: parsed.propertyId, envelope: parsed.envelope };
    }
    if (parsed.op === "ready") {
      return {
        op: "ready",
        siteId: typeof parsed.siteId === "string" ? parsed.siteId : undefined,
        authExpiresAt: typeof parsed.authExpiresAt === "number" ? parsed.authExpiresAt : null,
      };
    }
    if (parsed.op === "auth_expiring") {
      return { op: "auth_expiring" };
    }
    if (parsed.op === "error" && typeof parsed.error === "string") {
      return { op: "error", error: parsed.error, code: typeof parsed.code === "string" ? parsed.code : undefined };
    }
    return null;
  } catch {
    return null;
  }
}
