import type { RuleGroupType } from "./query-builder-types.js";

export type EventType = string;

export interface AppEvent {
  id: string;
  type: EventType;
  version: string;
  ts: string;
  payload: Record<string, unknown>;
  /** Value of the framework's `partitionField` (e.g. a site id). Only automations in this partition, plus global ones, see the event. */
  partition?: string;
  /** Value of the schema version's `scopeKey` field — what the event is about (a call id, a station id). */
  scope?: string;
  /** Id of the root event of the chain this event belongs to. Equals `id` for a root event. */
  correlationId: string;
  /** Id of the event that directly caused this one. Absent for a root event. */
  causationId?: string;
  /** How many automation-fired events deep this one is. 0 for a root event. */
  hop: number;
}

/**
 * Identity of the event that caused a new one. Built with `causeOf(event)` inside an action handler,
 * carried through whatever domain call the action makes, and handed back to `fire()` when the
 * resulting domain event re-enters the framework.
 */
export interface EventCause {
  correlationId: string;
  causationId: string;
  hop: number;
}

export type FactMap = Record<string, unknown>;

export interface FactDef {
  id: string; // e.g. "event.payload.station"
  label: string;
  type: "string" | "number" | "boolean";
  enumValues?: string[];
  ref?: RefAnnotation;
}

/** A JSON-schema-ish property used by the event + action schemas. */
export interface SchemaProperty {
  type: "string" | "number" | "array";
  title: string;
  description?: string;
  enum?: string[];
  items?: { type: "string" };
  ref?: RefAnnotation;
  matchable?: boolean;
}

export interface RefAnnotation {
  source: string;
  multi?: boolean;
}

export interface ActionInputSchema {
  required: string[];
  properties: Record<string, SchemaProperty>;
}

export interface EventSchemaVersion {
  payload: Record<string, SchemaProperty>;
  /** Payload field naming what the event is about (e.g. "callId"). A future timed action keys its cancel on it. */
  scopeKey?: string;
}

export interface EventSchema {
  type: EventType;
  displayName: string;
  latest: string;
  versions: Record<string, EventSchemaVersion>;
}

export interface ActionSchemaVersion {
  inputSchema: ActionInputSchema;
}

export interface ActionSchema {
  type: string;
  displayName: string;
  latest: string;
  versions: Record<string, ActionSchemaVersion>;
}

export interface TemplateVariable {
  key: string; // e.g. "event.payload.currentJob"
  label: string;
  example: string;
}

export interface AutomationAction {
  type: string;
  version: string;
  inputs: Record<string, unknown>;
}

export interface Automation {
  id: string;
  label: string;
  enabled: boolean;
  event: EventType;
  eventVersion: string;
  conditions: RuleGroupType;
  actions: AutomationAction[];
  /** Partition this automation belongs to (e.g. a site id). Null/absent = global, sees every partition's events. */
  partition?: string | null;
}

export interface Catalog {
  event: EventSchema;
  eventVersion: string;
  action: ActionSchema;
  actionVersion: string;
  actions: ActionSchema[];
  facts: FactDef[];
  variables: TemplateVariable[];
  operators: string[];
}
