export const LIVESTORE_EVENT_STREAM = "RW_LIVESTORE_EVENTS";
export const LIVESTORE_EVENT_SUBJECT_PREFIX = "livestore.events";
export const LIVESTORE_EVENT_SUBJECT_FILTER = `${LIVESTORE_EVENT_SUBJECT_PREFIX}.>`;

export type LivestoreHookContextFieldType = "string" | "number" | "boolean" | "object";
export type LivestoreHookContextSourceType = "property";

export interface LivestoreHookContextFieldSchema {
  label: string;
  type: LivestoreHookContextFieldType;
  required: boolean;
  description?: string;
  sourceTypes: readonly LivestoreHookContextSourceType[];
}

export interface LivestoreHookEventSchema {
  type: string;
  version: string;
  displayName: string;
  integration: string;
  description: string;
  contextFields: Record<string, LivestoreHookContextFieldSchema>;
}

export const LIVESTORE_HOOK_EVENT_CATALOG = [
  {
    type: "livestore.hook.triggered",
    version: "1",
    displayName: "LiveStore Hook Triggered",
    integration: "livestore",
    description: "Generic event emitted whenever a LiveStore hook condition matches.",
    contextFields: {},
  },
  {
    type: "imm.cycle.completed",
    version: "1",
    displayName: "IMM Cycle Completed",
    integration: "rockware-imm",
    description: "Rockware IMM event emitted when a configured cycle-complete condition matches.",
    contextFields: {
      stationId: {
        label: "Station",
        type: "string",
        required: true,
        description: "Station entity id where the cycle completed.",
        sourceTypes: ["property"],
      },
      jobId: {
        label: "Job",
        type: "string",
        required: false,
        description: "Current job id when the cycle completed.",
        sourceTypes: ["property"],
      },
      cycleTime: {
        label: "Cycle Time",
        type: "number",
        required: false,
        description: "Cycle time captured from the graph when the event is emitted.",
        sourceTypes: ["property"],
      },
    },
  },
] as const satisfies readonly LivestoreHookEventSchema[];

export interface LivestoreHookEventContextMetadata {
  propertyId: string;
  quality: string;
  timestamp: number;
}

export interface LivestoreHookEvent {
  id: string;
  type: string;
  version: string;
  siteId: string;
  hookId: string;
  hookName: string;
  propertyId: string;
  emittedAt: string;
  previous: unknown;
  current: unknown;
  payload: Record<string, unknown>;
  context: Record<string, LivestoreHookEventContextMetadata>;
}

function sanitizeSubjectToken(value: string): string {
  const token = value.trim().replaceAll("/", ".").replaceAll("\\", ".").replace(/\s+/g, "_");
  return token
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/[*>]/g, "_"))
    .join(".");
}

export function deriveLivestoreEventSubject(siteId: string, eventType: string): string {
  const siteToken = sanitizeSubjectToken(siteId);
  const eventToken = sanitizeSubjectToken(eventType);
  if (!siteToken) throw new Error("siteId must produce a non-empty LiveStore event subject token");
  if (!eventToken) throw new Error("eventType must produce a non-empty LiveStore event subject token");
  return `${LIVESTORE_EVENT_SUBJECT_PREFIX}.${siteToken}.${eventToken}`;
}

export function isKnownLivestoreHookEvent(type: string, version: string): boolean {
  return Boolean(getLivestoreHookEventSchema(type, version));
}

export function getLivestoreHookEventSchema(type: string, version: string): LivestoreHookEventSchema | null {
  return LIVESTORE_HOOK_EVENT_CATALOG.find((event) => event.type === type && event.version === version) ?? null;
}
