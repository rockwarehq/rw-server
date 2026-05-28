import type { ContextBuilder, EventSchema, EventType } from "@rw/triggers";
import * as jobChanged from "./job-changed.js";

/**
 * Event aggregator. Each event module exports `schema` + `contextBuilder`; this file collects them
 * into the maps the framework consumes. Add a new event = drop a module in this folder, add one
 * import + one entry below. Schema and context builder can't drift because they're declared in the
 * same module.
 */

type EventModule = { schema: EventSchema; contextBuilder: ContextBuilder };

const modules: readonly EventModule[] = [jobChanged] as const;

/** Every event type the app understands, keyed by type. */
export const EVENT_SCHEMAS: Record<EventType, EventSchema> = Object.fromEntries(
  modules.map((m) => [m.schema.type, m.schema]),
);

/** Per-event-type fact builders (SEAM A). One per event module. */
export function buildContextBuilders(): Record<EventType, ContextBuilder> {
  return Object.fromEntries(modules.map((m) => [m.schema.type, m.contextBuilder]));
}
