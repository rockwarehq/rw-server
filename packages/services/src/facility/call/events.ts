import { randomUUID } from "node:crypto";

import type { CallEvent } from "@rw/runtime/call-events";

export type CallEventSink = (event: CallEvent) => void | Promise<void>;

let sink: CallEventSink | null = null;

export function setCallEventSink(next: CallEventSink | null): void {
  sink = next;
}

export function publishCallEvent(input: Omit<CallEvent, "id" | "emittedAt">): void {
  const event: CallEvent = {
    ...input,
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
  };

  if (!sink) return;

  try {
    void Promise.resolve(sink(event)).catch((err) => {
      console.error("[call-events] sink failed:", err);
    });
  } catch (err) {
    console.error("[call-events] sink failed:", err);
  }
}
