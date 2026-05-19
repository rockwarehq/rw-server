// Lifted from rw-server/src/rpc/events-bus.ts in Phase 0 task #9.
// Stub for now; full implementation comes when the API and Workers wire up.

export type StreamEvent = unknown;

export function publishStreamEvent(_event: StreamEvent): void {
  throw new Error("events-bus not yet wired up — initEventsBridge() first");
}

export async function initEventsBridge(_mode: "publisher" | "subscriber"): Promise<() => Promise<void>> {
  throw new Error("events-bus not yet wired up");
}
