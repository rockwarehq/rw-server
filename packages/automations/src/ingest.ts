import type { AutomationEngine } from "./engine.js";
import type { AppEvent } from "./types.js";

/**
 * SEAM B — how events get from the edge into the engine. Returns the ids of automations that fired.
 *
 * Today: synchronous — the caller awaits dispatch inline, fine for low-volume business events.
 * A high-volume source would implement this same interface backed by a bounded queue +
 * backpressure, draining into the same `engine.dispatch`.
 */
export interface IngestRuntime {
  submit(event: AppEvent): Promise<string[]>;
}

/** Evaluate inline, on the calling request/worker. */
export function createSyncIngestRuntime(engine: AutomationEngine): IngestRuntime {
  return {
    submit(event) {
      return engine.dispatch(event);
    },
  };
}
