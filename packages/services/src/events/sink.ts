import { randomUUID } from "node:crypto";

export type EventSink<T> = (event: T) => void | Promise<void>;

/**
 * Transport-independent publish seam for a domain's outbound events: the app installs a sink
 * (NATS in apps/api) and services publish without knowing where events go. Publishing with no
 * sink installed is a no-op; a failing sink is logged, never thrown into the write path.
 */
export function createEventSink<T extends { id: string; emittedAt: string }>(name: string) {
  let sink: EventSink<T> | null = null;
  return {
    set(next: EventSink<T> | null): void {
      sink = next;
    },
    publish(input: Omit<T, "id" | "emittedAt">): void {
      if (!sink) return;
      const event = { ...input, id: randomUUID(), emittedAt: new Date().toISOString() } as T;
      Promise.resolve()
        .then(() => sink?.(event))
        .catch((err) => console.error(`[${name}] sink failed:`, err));
    },
  };
}
