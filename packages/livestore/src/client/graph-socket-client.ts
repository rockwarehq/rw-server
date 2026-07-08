// Browser-safe reconnecting client for the livestore /ws/graph endpoint.
// No server imports here — dashboards deep-import this via "@rw/livestore/client/*".

export type GraphSocketState = "connecting" | "open" | "closed";

export interface GraphSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface ReconnectingGraphSocketOptions {
  url: string;
  onValue: (propertyId: string, envelope: unknown) => void;
  onError?: (error: string) => void;
  onStateChange?: (state: GraphSocketState) => void;
  /** Defaults to globalThis.WebSocket; override for Node or tests. */
  webSocketFactory?: (url: string) => GraphSocketLike;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const WS_OPEN = 1;

/**
 * Maintains a desired subscription set across connection drops: on every
 * (re)connect it replays a subscribe for the full set, and the server responds
 * with current values, so a reconnect fully recovers state.
 */
export class ReconnectingGraphSocket {
  private readonly options: ReconnectingGraphSocketOptions;
  private readonly desired = new Set<string>();
  private ws: GraphSocketLike | null = null;
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

  private sendOp(op: "subscribe" | "unsubscribe", propertyIds: string[]): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify({ op, propertyIds }));
    }
    // Not open: the desired set is replayed on the next connect.
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

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.options.onStateChange?.("open");
      if (this.desired.size > 0) {
        ws.send(JSON.stringify({ op: "subscribe", propertyIds: [...this.desired] }));
      }
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.op === "value") this.options.onValue(message.propertyId, message.envelope);
      else this.options.onError?.(message.error);
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
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
  | { op: "error"; error: string };

function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as { op?: unknown; propertyId?: unknown; error?: unknown; envelope?: unknown };
    if (parsed.op === "value" && typeof parsed.propertyId === "string") {
      return { op: "value", propertyId: parsed.propertyId, envelope: parsed.envelope };
    }
    if (parsed.op === "error" && typeof parsed.error === "string") {
      return { op: "error", error: parsed.error };
    }
    return null;
  } catch {
    return null;
  }
}
