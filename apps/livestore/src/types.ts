export type Quality = "good" | "stale" | "uncertain" | "bad";

export interface ValueEnvelope {
  value: unknown;
  quality: Quality;
  timestamp: number;
  context?: Record<string, unknown>;
}

export interface TagResolverConfig {
  type: "tag";
  deviceId: string;
  tagPath: string;
}

export type Aggregation = "sum" | "avg" | "count" | "min" | "max";

export interface RollupResolverConfig {
  type: "rollup";
  childKind: string;
  relation: string;
  childProperty: string;
  aggregation: Aggregation;
  weightBy?: string;
}

export interface MetricResolverConfig {
  type: "metric";
  granularity: string;
  metricKey: string;
}

export interface ExprResolverConfig {
  type: "expr";
  expression: string;
}

export type GraphResolver =
  | TagResolverConfig
  | RollupResolverConfig
  | MetricResolverConfig
  | ExprResolverConfig
  | ({ type: string } & Record<string, unknown>);

export interface NodeRuntime {
  id: string;
  name: string;
  kind: string | null;
  entityType: string | null;
  entityId: string | null;
  propertyIds: string[];
}

export interface PropertyRuntime {
  id: string;
  nodeId: string;
  name: string;
  resolverType: string;
  resolver: GraphResolver;
  sampleRateMs: number | null;
  current: ValueEnvelope;
}

export interface GraphEdgeRuntime {
  id: string;
  fromPropertyId: string;
  toPropertyId: string;
}

export interface GraphSnapshotNode extends Omit<NodeRuntime, "propertyIds"> {
  properties: GraphSnapshotProperty[];
}

export interface GraphSnapshotProperty extends Omit<PropertyRuntime, "current"> {
  current: ValueEnvelope;
}

export type CommitSource = "tag" | "entity" | "expr" | "rollup" | "metric" | "manual";

export interface LivestoreLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

const QUALITY_VALUES = new Set<Quality>(["good", "stale", "uncertain", "bad"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isQuality(value: unknown): value is Quality {
  return typeof value === "string" && QUALITY_VALUES.has(value as Quality);
}

export function isValueEnvelope(value: unknown): value is ValueEnvelope {
  if (!isRecord(value)) return false;
  if (!isQuality(value.quality)) return false;
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
  if (value.context !== undefined && !isRecord(value.context)) return false;
  return "value" in value;
}

export function parseValueEnvelope(value: unknown): ValueEnvelope | null {
  return isValueEnvelope(value) ? value : null;
}

export function staleEnvelope(timestamp = Date.now()): ValueEnvelope {
  return { value: null, quality: "stale", timestamp };
}

export function parseGraphResolver(value: unknown, resolverType: string): GraphResolver {
  if (!isRecord(value)) return { type: resolverType };
  const type = typeof value.type === "string" ? value.type : resolverType;
  return { ...value, type };
}

export function isTagResolverConfig(value: GraphResolver): value is TagResolverConfig {
  return value.type === "tag" && typeof value.deviceId === "string" && typeof value.tagPath === "string";
}

export function isRollupResolverConfig(value: GraphResolver): value is RollupResolverConfig {
  return (
    value.type === "rollup" &&
    typeof (value as RollupResolverConfig).childKind === "string" &&
    typeof (value as RollupResolverConfig).relation === "string" &&
    typeof (value as RollupResolverConfig).childProperty === "string" &&
    typeof (value as RollupResolverConfig).aggregation === "string"
  );
}

export function isExprResolverConfig(value: GraphResolver): value is ExprResolverConfig {
  return value.type === "expr" && typeof (value as ExprResolverConfig).expression === "string";
}

export function isMetricResolver(value: GraphResolver): value is MetricResolverConfig {
  return (
    value.type === "metric" &&
    typeof (value as MetricResolverConfig).granularity === "string" &&
    typeof (value as MetricResolverConfig).metricKey === "string"
  );
}

// Worst-of quality ordering (spec §8.6): good < stale < uncertain < bad.
const QUALITY_RANK: Record<Quality, number> = { good: 0, stale: 1, uncertain: 2, bad: 3 };
export function worse(a: Quality, b: Quality): Quality {
  return QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;
}

// A finite numeric contribution from an envelope, or null when it can't be used
// (missing value, bad quality, non-finite) — the shared input guard for expr + rollup.
export function usableValue(env: ValueEnvelope): number | null {
  if (env.value == null || env.quality === "bad") return null;
  const v = Number(env.value);
  return Number.isFinite(v) ? v : null;
}

export function envelopesEqual(a: ValueEnvelope, b: ValueEnvelope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
