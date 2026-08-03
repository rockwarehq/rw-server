import type { LivestoreHookContextFieldType } from "./events.js";

export type GraphHookConditionOperator =
  | "changed"
  | "increases"
  | "decreases"
  | "equals"
  | "notEquals"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "crossesAbove"
  | "crossesBelow";

export interface GraphHookPropertyCondition {
  source: {
    type: "property";
    propertyId: string;
  };
  operator: GraphHookConditionOperator;
  value?: unknown;
  threshold?: number;
  minDelta?: number;
}

export type GraphHookCondition = GraphHookPropertyCondition;

export interface GraphHookPropertyContextBinding {
  source: {
    type: "property";
    propertyId: string;
  };
  // dynamicContext events only: the author declares the type the catalog lacks.
  valueType?: LivestoreHookContextFieldType;
  // Author-declared fields default to required: skip rather than emit it missing.
  required?: boolean;
}

export type GraphHookEventContextBinding = GraphHookPropertyContextBinding;
export type GraphHookEventContext = Record<string, GraphHookEventContextBinding>;

const OPERATORS = new Set<GraphHookConditionOperator>([
  "changed",
  "increases",
  "decreases",
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  "crossesAbove",
  "crossesBelow",
]);

const CONTEXT_VALUE_TYPES = new Set<LivestoreHookContextFieldType>(["string", "number", "boolean", "object"]);

const VALUE_OPERATORS = new Set<GraphHookConditionOperator>(["equals", "notEquals"]);
const THRESHOLD_OPERATORS = new Set<GraphHookConditionOperator>([
  "gt",
  "gte",
  "lt",
  "lte",
  "crossesAbove",
  "crossesBelow",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGraphHookCondition(value: unknown): GraphHookCondition | null {
  if (!isRecord(value) || !isRecord(value.source)) return null;
  if (value.source.type !== "property" || typeof value.source.propertyId !== "string") return null;
  if (typeof value.operator !== "string" || !OPERATORS.has(value.operator as GraphHookConditionOperator)) return null;

  const operator = value.operator as GraphHookConditionOperator;
  if (VALUE_OPERATORS.has(operator) && !("value" in value)) return null;
  if (THRESHOLD_OPERATORS.has(operator)) {
    if (typeof value.threshold !== "number" || !Number.isFinite(value.threshold)) return null;
  }
  if (
    value.minDelta !== undefined &&
    (typeof value.minDelta !== "number" || !Number.isFinite(value.minDelta) || value.minDelta < 0)
  ) {
    return null;
  }

  return {
    source: {
      type: "property",
      propertyId: value.source.propertyId,
    },
    operator,
    ...("value" in value ? { value: value.value } : {}),
    ...(typeof value.threshold === "number" ? { threshold: value.threshold } : {}),
    ...(typeof value.minDelta === "number" ? { minDelta: value.minDelta } : {}),
  };
}

export function graphHookConditionPropertyIds(condition: GraphHookCondition): string[] {
  return [condition.source.propertyId];
}

export function parseGraphHookEventContext(value: unknown): GraphHookEventContext | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;

  const context: GraphHookEventContext = {};
  for (const [field, binding] of Object.entries(value)) {
    if (!isRecord(binding) || !isRecord(binding.source)) return null;
    if (binding.source.type !== "property" || typeof binding.source.propertyId !== "string") return null;
    if (
      binding.valueType !== undefined &&
      !CONTEXT_VALUE_TYPES.has(binding.valueType as LivestoreHookContextFieldType)
    ) {
      return null;
    }
    if (binding.required !== undefined && typeof binding.required !== "boolean") return null;

    context[field] = {
      source: {
        type: "property",
        propertyId: binding.source.propertyId,
      },
      ...(binding.valueType !== undefined ? { valueType: binding.valueType as LivestoreHookContextFieldType } : {}),
      ...(typeof binding.required === "boolean" ? { required: binding.required } : {}),
    };
  }
  return context;
}

// Becomes a payload key and then a SQL parameter name, so restrict not escape.
const CONTEXT_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function isValidHookContextFieldName(field: string): boolean {
  return CONTEXT_FIELD_NAME.test(field);
}

export function graphHookEventContextPropertyIds(context: GraphHookEventContext): string[] {
  return Object.values(context).map((binding) => binding.source.propertyId);
}
