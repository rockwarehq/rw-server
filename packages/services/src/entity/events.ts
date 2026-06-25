import { randomUUID } from "node:crypto";

import type { EntityEvent, EntityEventAction } from "@rw/runtime/entity-events";

export type EntityEventSink = (event: EntityEvent) => void | Promise<void>;

let sink: EntityEventSink | null = null;

export function setEntityEventSink(next: EntityEventSink | null): void {
  sink = next;
}

export function publishEntityEvent(input: {
  action: EntityEventAction;
  entityKey: string;
  entityId: string;
  siteId: string;
  workspaceId: string;
  changedFields?: string[];
}): void {
  if (!sink) return;

  const event: EntityEvent = {
    id: randomUUID(),
    action: input.action,
    entityKey: input.entityKey,
    entityId: input.entityId,
    siteId: input.siteId,
    workspaceId: input.workspaceId,
    ...(input.changedFields && input.changedFields.length > 0 ? { changedFields: input.changedFields } : {}),
    emittedAt: new Date().toISOString(),
  };

  try {
    void Promise.resolve(sink(event)).catch((err) => {
      console.error("[entity-events] sink failed:", err);
    });
  } catch (err) {
    console.error("[entity-events] sink failed:", err);
  }
}
