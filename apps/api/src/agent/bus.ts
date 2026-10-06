import { EventEmitter } from "node:events";

import { getNatsConnection } from "../nats/util.js";

// Cross-process signals for agent sessions: "events were committed" wakes,
// live streaming deltas, interrupts, and the run queue's local fallback.
// Plain NATS subjects when NATS is configured, so any api node can serve a
// subscriber or interrupt a run held by another node; an in-process emitter
// otherwise (single process: dev without NATS, tests).

const local = new EventEmitter();
local.setMaxListeners(0);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function publish(subject: string, data: string): Promise<void> {
  const nc = await getNatsConnection();
  if (nc) {
    nc.publish(subject, encoder.encode(data));
    return;
  }
  local.emit(subject, data);
}

/** Subscribe to a subject; returns an unsubscribe function. */
export async function subscribe(subject: string, handler: (data: string) => void): Promise<() => void> {
  const nc = await getNatsConnection();
  if (nc) {
    const sub = nc.subscribe(subject, {
      callback: (err, message) => {
        if (!err) handler(decoder.decode(message.data));
      },
    });
    return () => sub.unsubscribe();
  }
  local.on(subject, handler);
  return () => local.off(subject, handler);
}
