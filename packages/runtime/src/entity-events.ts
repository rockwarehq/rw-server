export const ENTITY_EVENT_STREAM = "RW_ENTITY_EVENTS";
export const ENTITY_EVENT_SUBJECT_PREFIX = "entity.changes";
export const ENTITY_EVENT_SUBJECT_FILTER = `${ENTITY_EVENT_SUBJECT_PREFIX}.>`;
export const ENTITY_EVENT_DURABLE = "rw-livestore-entity-events";

export type EntityEventAction = "created" | "updated" | "deleted";

export interface EntityEvent {
  id: string;
  action: EntityEventAction;
  entityKey: string;
  entityId: string;
  siteId: string;
  workspaceId: string;
  changedFields?: string[];
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

export function deriveEntityEventSubject(input: {
  siteId: string;
  entityKey: string;
  entityId: string;
  action: EntityEventAction;
}): string {
  const site = sanitizeSubjectToken(input.siteId);
  const entityKey = sanitizeSubjectToken(input.entityKey);
  const entityId = sanitizeSubjectToken(input.entityId);
  const action = sanitizeSubjectToken(input.action);
  if (!site || !entityKey || !entityId || !action) {
    throw new Error("entity event subject requires siteId, entityKey, entityId, and action");
  }
  return `${ENTITY_EVENT_SUBJECT_PREFIX}.${site}.${entityKey}.${entityId}.${action}`;
}

export function isEntityEvent(value: unknown): value is EntityEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<EntityEvent>;
  return (
    typeof event.id === "string" &&
    (event.action === "created" || event.action === "updated" || event.action === "deleted") &&
    typeof event.entityKey === "string" &&
    typeof event.entityId === "string" &&
    typeof event.siteId === "string" &&
    typeof event.workspaceId === "string" &&
    typeof event.emittedAt === "string" &&
    (event.changedFields === undefined ||
      (Array.isArray(event.changedFields) && event.changedFields.every((field) => typeof field === "string")))
  );
}

export function parseEntityEvent(value: unknown): EntityEvent | null {
  return isEntityEvent(value) ? value : null;
}
