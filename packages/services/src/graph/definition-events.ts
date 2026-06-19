import { randomUUID } from "node:crypto";

import type { GraphDefinitionAction, GraphDefinitionEntity, GraphDefinitionEvent } from "@rw/runtime/graph-definitions";

export type GraphDefinitionEventSink = (event: GraphDefinitionEvent) => void | Promise<void>;

let sink: GraphDefinitionEventSink | null = null;

export function setGraphDefinitionEventSink(next: GraphDefinitionEventSink | null): void {
  sink = next;
}

export function publishGraphDefinitionEvent(input: {
  entity: GraphDefinitionEntity;
  action: GraphDefinitionAction;
  entityId: string;
  siteId: string;
  nodeId?: string;
}): void {
  if (!sink) return;

  const event: GraphDefinitionEvent = {
    id: randomUUID(),
    entity: input.entity,
    action: input.action,
    entityId: input.entityId,
    siteId: input.siteId,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    emittedAt: new Date().toISOString(),
  };

  try {
    void Promise.resolve(sink(event)).catch((err) => {
      console.error("[graph-definition-events] sink failed:", err);
    });
  } catch (err) {
    console.error("[graph-definition-events] sink failed:", err);
  }
}
