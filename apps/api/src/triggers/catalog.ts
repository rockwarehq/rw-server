import { QB_OPERATORS } from "./qb-to-engine.js";
import type { ActionSchema, Catalog, EventSchema, EventType, FactDef, TemplateVariable } from "./types.js";

/**
 * Single source of truth for event + action SCHEMAS. Served to clients over the API and used by
 * the server to validate + drive the engine.
 *
 * Behavior attached to these schemas lives elsewhere and is wired in registry.ts:
 *   - how an event becomes facts  -> a ContextBuilder (context.ts)
 *   - what an action does          -> an ActionHandler (actions.ts)
 * Adding an event/action type = a schema entry here + its behavior in the registry. The engine,
 * ingestion, and validation derive from these declarations.
 */

/** Every event type the framework understands, keyed by type. */
export const EVENT_SCHEMAS: Record<EventType, EventSchema> = {
  "job.changed": {
    type: "job.changed",
    displayName: "Job Changed",
    payload: {
      previousJob: { type: "string", title: "Previous Job" },
      currentJob: { type: "string", title: "Current Job" },
      department: { type: "string", title: "Department" },
      station: { type: "string", title: "Station" },
      businessDate: { type: "string", title: "Business Date" },
      shift: { type: "string", title: "Shift" },
    },
  },
};

/** Every action the framework understands, keyed by type. */
export const ACTION_SCHEMAS: Record<string, ActionSchema> = {
  sendAlert: {
    type: "sendAlert",
    displayName: "Send Alert",
    inputSchema: {
      required: ["text", "emails"],
      properties: {
        text: {
          type: "string",
          title: "Alert Text",
          description: "Message to log. Supports {{event.payload.*}} variables.",
        },
        emails: {
          type: "array",
          items: { type: "string" },
          title: "Recipient Emails",
          description: "One email per row. Supports variables.",
        },
      },
    },
  },
  // Later: "createForm", "sendEmail", … declared here, handlers registered in registry.ts.
};

/** What the single-event editor renders by default. */
export const DEFAULT_EVENT_TYPE: EventType = "job.changed";
export const DEFAULT_ACTION_TYPE = "sendAlert";

/** Condition-builder fields for one event type: event.type + each payload field. */
function factsFor(schema: EventSchema): FactDef[] {
  return [
    { id: "event.type", label: "Event Type", type: "string" },
    ...Object.entries(schema.payload).map(
      ([key, prop]): FactDef => ({
        id: `event.payload.${key}`,
        label: prop.title,
        type: "string",
      }),
    ),
  ];
}

/** Template variables insertable into action inputs: payload fields + event/system tokens. */
function variablesFor(schema: EventSchema): TemplateVariable[] {
  return [
    ...Object.entries(schema.payload).map(
      ([key, prop]): TemplateVariable => ({
        key: `event.payload.${key}`,
        label: prop.title,
        example: "",
      }),
    ),
    { key: "event.type", label: "Event Type", example: schema.type },
    { key: "event.id", label: "Event ID", example: "ab12cd34" },
    { key: "event.ts", label: "Event Timestamp", example: new Date().toISOString() },
    { key: "sys.timestamp", label: "Now (ISO)", example: new Date().toISOString() },
  ];
}

/** Build the editor catalog for one event type + one action. */
export function buildCatalog(
  eventType: EventType = DEFAULT_EVENT_TYPE,
  actionType: string = DEFAULT_ACTION_TYPE,
): Catalog {
  const event = EVENT_SCHEMAS[eventType];
  const action = ACTION_SCHEMAS[actionType];
  if (!event) throw new Error(`unknown event type: ${eventType}`);
  if (!action) throw new Error(`unknown action type: ${actionType}`);
  return {
    event,
    action,
    actions: Object.values(ACTION_SCHEMAS),
    facts: factsFor(event),
    variables: variablesFor(event),
    operators: QB_OPERATORS,
  };
}
