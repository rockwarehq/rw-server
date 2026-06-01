import type { ContextBuilder, EventSchema, EventType } from "@rw/automations";
import * as jobChanged from "./job-changed.js";

type EventModule = { schema: EventSchema; contextBuilder: ContextBuilder };

const modules: readonly EventModule[] = [jobChanged] as const;

export const EVENT_SCHEMAS: Record<EventType, EventSchema> = Object.fromEntries(
  modules.map((m) => [m.schema.type, m.schema]),
);

export function buildContextBuilders(): Record<EventType, ContextBuilder> {
  return Object.fromEntries(modules.map((m) => [m.schema.type, m.contextBuilder]));
}
