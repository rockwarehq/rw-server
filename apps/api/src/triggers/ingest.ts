import type { TriggerEngine } from "./engine.js";
import type { AppEvent, Notify } from "./types.js";

/**
 * SEAM B — how events get from the edge into the engine. Returns the ids of triggers that fired.
 *
 * Today: synchronous — the caller awaits dispatch inline, fine for low-volume business events.
 * A high-volume source would implement this same interface backed by a bounded queue +
 * backpressure, draining into the same `engine.dispatch`.
 */
export interface IngestRuntime {
  submit(event: AppEvent): Promise<string[]>;
}

/** Evaluate inline, on the calling request/worker. */
export class SyncIngestRuntime implements IngestRuntime {
  constructor(
    private readonly engine: TriggerEngine,
    private readonly notify: Notify,
  ) {}

  submit(event: AppEvent): Promise<string[]> {
    return this.engine.dispatch(event, this.notify);
  }
}
