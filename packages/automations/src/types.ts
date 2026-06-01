import type { RuleGroupType } from "./query-builder-types.js";

export type EventType = string;

export interface AppEvent {
  id: string;
  type: EventType;
  version: string;
  ts: string;
  payload: Record<string, unknown>;
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
