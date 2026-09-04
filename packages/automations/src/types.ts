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
  /** Value of the schema version's `cooldownKey` field (defaults to `scopeKey`) — the unit a cooldown applies to. */
  cooldownScope?: string;
  /** ISO value of the schema version's `sinceKey` field — when the condition began; delayed actions measure from it. */
  since?: string;
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
  /** Payload field naming what the event is about (e.g. "callId"). Delayed actions are armed and cancelled per scope value. */
  scopeKey?: string;
  /** Payload field a cooldown is keyed on (e.g. "stationId"). Defaults to `scopeKey`; absent = per automation. */
  cooldownKey?: string;
  /** Payload field holding an ISO time the condition began (e.g. "statusSince", "openedAt"). A delayed action's clock starts there, not at the event. */
  sinceKey?: string;
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
  /** Run this long after the match instead of immediately; cancelled if the scope's next event no longer matches. Null/0 = immediate. */
  delayMs?: number | null;
  /** After a delayed fire, re-arm on the scope's next match. Off = fire once per scope until a non-matching event clears it. */
  repeat?: boolean | null;
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
  /** After firing for a cooldown scope, ignore further matches for that scope this long. Null/0 = none. */
  cooldownMs?: number | null;
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
