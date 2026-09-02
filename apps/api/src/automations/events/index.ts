import type { ContextBuilder, EventSchema, EventType } from "@rw/automations";
import * as callChanged from "./call-changed.js";
import * as jobChanged from "./job-changed.js";
import * as modeChanged from "./mode-changed.js";
import * as notificationChanged from "./notification-changed.js";

type EventModule = { schema: EventSchema; contextBuilder: ContextBuilder };

const modules: readonly EventModule[] = [jobChanged, callChanged, modeChanged, notificationChanged] as const;

export const EVENT_SCHEMAS: Record<EventType, EventSchema> = Object.fromEntries(
  modules.map((m) => [m.schema.type, m.schema]),
);

export function buildContextBuilders(): Record<EventType, ContextBuilder> {
  return Object.fromEntries(modules.map((m) => [m.schema.type, m.contextBuilder]));
}
