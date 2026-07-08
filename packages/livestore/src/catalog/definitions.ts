export const GRAPH_DEFINITION_STREAM = "RW_GRAPH_DEFINITIONS";
export const GRAPH_DEFINITION_SUBJECT_PREFIX = "graph.definitions";
export const GRAPH_DEFINITION_SUBJECT_FILTER = `${GRAPH_DEFINITION_SUBJECT_PREFIX}.>`;
export const GRAPH_DEFINITION_DURABLE = "rw-livestore-graph-definitions";

export type GraphDefinitionEntity = "node" | "property" | "hook";
export type GraphDefinitionAction = "created" | "updated" | "deleted";

export interface GraphDefinitionEvent {
  id: string;
  entity: GraphDefinitionEntity;
  action: GraphDefinitionAction;
  entityId: string;
  siteId: string;
  nodeId?: string;
  emittedAt: string;
}

function sanitizeSubjectToken(value: string): string {
  const token = value.trim().replaceAll("/", ".").replaceAll("\\", ".").replace(/\s+/g, "_");
  return token
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/[*>]/g, "_"))
    .join(".");
}

export function deriveGraphDefinitionSubject(siteId: string): string {
  const siteToken = sanitizeSubjectToken(siteId);
  if (!siteToken) throw new Error("siteId must produce a non-empty graph definition subject token");
  return `${GRAPH_DEFINITION_SUBJECT_PREFIX}.${siteToken}`;
}

export function isGraphDefinitionEvent(value: unknown): value is GraphDefinitionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<GraphDefinitionEvent>;
  return (
    typeof event.id === "string" &&
    (event.entity === "node" || event.entity === "property" || event.entity === "hook") &&
    (event.action === "created" || event.action === "updated" || event.action === "deleted") &&
    typeof event.entityId === "string" &&
    typeof event.siteId === "string" &&
    typeof event.emittedAt === "string" &&
    (event.nodeId === undefined || typeof event.nodeId === "string")
  );
}

export function parseGraphDefinitionEvent(value: unknown): GraphDefinitionEvent | null {
  return isGraphDefinitionEvent(value) ? value : null;
}
