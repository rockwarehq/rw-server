import { nanoid } from "nanoid";
import { buildCatalog } from "./catalog.js";
import { TriggerEngine } from "./engine.js";
import { type IngestRuntime, SyncIngestRuntime } from "./ingest.js";
import { buildActionRegistry, buildContextBuilders } from "./registry.js";
import { createFileTriggerStore, type TriggerStore } from "./store.js";
import type { AppEvent, Catalog, EventType, Notify } from "./types.js";
import { validateEventPayload } from "./validate.js";

/**
 * Trigger framework, ported from the eventdrivenarch-simple reference.
 *
 * Wiring TODO (intentionally left as seams):
 *   - Real event source: instead of `fire(...)`, call `framework.ingest.submit(event)` from a real
 *     `job.changed` producer (a worker, a domain event bus, etc.).
 *   - Persistence: the store is a MOCK file-backed store. Swap for `@rw/db`.
 *   - Notifications: `notify` defaults to a console logger.
 */
export interface TriggerFramework {
  store: TriggerStore;
  engine: TriggerEngine;
  ingest: IngestRuntime;
  catalog(eventType?: EventType, actionType?: string): Catalog;
  /**
   * Validate a payload against its event type's schema, then (if valid) build + submit the event.
   * Stand-in for a real event source. Returns a discriminated union so a bad payload never throws.
   */
  fire(
    type: EventType,
    payload: Record<string, unknown>,
  ): Promise<{ ok: false; error: string } | { ok: true; eventId: string; matched: string[] }>;
}

const defaultNotify: Notify = (n) => {
  if (n.type === "triggerFired") {
    console.log(`[triggers] fired "${n.label}" (${n.triggerId}) for event ${n.eventId}`);
  }
};

export interface CreateTriggerFrameworkOptions {
  store?: TriggerStore;
  notify?: Notify;
}

export function createTriggerFramework(opts: CreateTriggerFrameworkOptions = {}): TriggerFramework {
  const store = opts.store ?? createFileTriggerStore();
  const notify = opts.notify ?? defaultNotify;
  const { contextBuilders, defaultContextBuilder } = buildContextBuilders();
  const actions = buildActionRegistry();
  const engine = new TriggerEngine({ store, contextBuilders, defaultContextBuilder, actions });
  engine.reload();
  const ingest = new SyncIngestRuntime(engine, notify);

  return {
    store,
    engine,
    ingest,
    catalog: (eventType, actionType) => buildCatalog(eventType, actionType),
    async fire(type, payload) {
      const v = validateEventPayload(type, payload);
      if (!v.ok) return { ok: false, error: v.error };
      const event: AppEvent = { id: nanoid(8), type, ts: new Date().toISOString(), payload: v.value };
      const matched = await ingest.submit(event);
      return { ok: true, eventId: event.id, matched };
    },
  };
}

let singleton: TriggerFramework | undefined;

/** Lazily-created shared framework instance (mock store). Used by the REST + oRPC layers. */
export function getTriggerFramework(): TriggerFramework {
  if (!singleton) singleton = createTriggerFramework();
  return singleton;
}

export type { AppEvent, Catalog, EventType, Trigger, TriggerAction } from "./types.js";
export type { TriggerStore } from "./store.js";
