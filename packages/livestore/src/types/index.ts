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

const AGGREGATION_VALUES = new Set<Aggregation>(["sum", "avg", "count", "min", "max"]);

export function isAggregation(value: unknown): value is Aggregation {
  return typeof value === "string" && AGGREGATION_VALUES.has(value as Aggregation);
}

export interface RollupResolverConfig {
  type: "rollup";
  parent?: { model: string; id: string };
  childKind: string;
  relation: string;
  childProperty: string;
  aggregation: Aggregation;
  weightBy?: string;
}

// Structural mirror of GraphHookCondition (catalog/hook-conditions.ts); kept
// here so base types don't import the catalog.
export interface TotalizerTriggerConfig {
  source: { type: "property"; propertyId: string };
  operator: string;
  value?: unknown;
  threshold?: number;
  minDelta?: number;
}

// Running total: each trigger firing adds the source's latest value (ADR-0010).
// Optional reset zeroes total+count when its condition fires (e.g. shift change).
export interface TotalizerResolverConfig {
  type: "totalizer";
  sourcePropertyId: string;
  trigger: TotalizerTriggerConfig;
  reset?: TotalizerTriggerConfig;
}

// Time-windowed aggregation over one source property (spec §17.3).
// aggregation/windowMs/alignToMs are tumbling-only; alpha is ewma-only.
export interface WindowResolverConfig {
  type: "window";
  sourcePropertyId: string;
  kind: "tumbling" | "ewma";
  aggregation?: Aggregation;
  windowMs?: number;
  alignToMs?: number;
  alpha?: number;
}

export interface MetricResolverConfig {
  type: "metric";
  entityType: string;
  entityId: string;
  granularity: string;
  metricKey: string;
}

export interface ExprResolverConfig {
  type: "expr";
  expression: string;
}

export interface EntityResolverConfig {
  type: "entity";
  entityType: string;
  entityId: string;
  path: string;
}

export type GraphResolver =
  | TagResolverConfig
  | RollupResolverConfig
  | MetricResolverConfig
  | ExprResolverConfig
  | EntityResolverConfig
  | WindowResolverConfig
  | TotalizerResolverConfig
  | ({ type: string } & Record<string, unknown>);

// Stateful fold resolvers (KV-persisted state, synchronous per-commit folds).
// They must not chain: a stateful input compounds restart/catch-up artifacts
// into downstream state (spec §17.10, ADR-0010).
export function isStatefulResolverType(resolverType: string): boolean {
  return resolverType === "window" || resolverType === "totalizer";
}

// Aggregation state persisted to imm_agg_state, keyed agg.<propertyId> (spec §17.4).
// Internal to the engine — never exposed to WS clients.
export interface TumblingState {
  kind: "tumbling";
  bucketStart: number; // ms, inclusive
  bucketEnd: number; // ms, exclusive (== bucketStart + windowMs)
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  goodCount: number; // samples with quality 'good'
  totalCount: number; // samples seen (incl. non-good)
  // Which property the state was folded from; state persisted before this
  // field existed omits it. Rehydrate discards state from a different source.
  sourcePropertyId?: string;
}

export interface EwmaState {
  kind: "ewma";
  value: number;
  lastInputTs: number; // ms, for staleness reporting
  lastInputQuality: Quality;
  // See TumblingState.sourcePropertyId.
  sourcePropertyId?: string;
}

// Unbounded running total: each trigger firing adds the latest source value.
export interface TotalizerState {
  kind: "totalizer";
  total: number;
  count: number; // adds performed
  lastQuality: Quality; // quality of the last add's inputs
  lastTriggerValue: unknown; // last good trigger sample (null until seen)
  lastTriggerTs: number; // 0 = no trigger sample seen yet
  lastResetValue: unknown; // last good reset sample (null until seen)
  lastResetTs: number; // 0 = no reset sample seen yet
  lastEmitTs: number; // ts of the last add/reset emit (0 = none); boot re-emits stamp this
  latestSourceValue: number | null;
  latestSourceQuality: Quality;
  // See TumblingState.sourcePropertyId; trigger/reset tracked the same way.
  sourcePropertyId?: string;
  triggerPropertyId?: string;
  resetPropertyId?: string;
}

export type AggState = TumblingState | EwmaState | TotalizerState;

export interface NodeRuntime {
  id: string;
  name: string;
  siteId: string;
  typeRef: string | null;
  typeContext: Record<string, unknown>;
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

export type CommitSource = "tag" | "entity" | "expr" | "window" | "totalizer" | "rollup" | "metric" | "manual";

export interface LivestoreLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
  // Optional: hot-path logs (per-commit) use this when present. Fastify's Pino
  // instance provides it; bare test loggers may omit it.
  debug?: (obj: Record<string, unknown>, msg?: string) => void;
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
    typeof (value as MetricResolverConfig).entityType === "string" &&
    typeof (value as MetricResolverConfig).entityId === "string" &&
    typeof (value as MetricResolverConfig).granularity === "string" &&
    typeof (value as MetricResolverConfig).metricKey === "string"
  );
}

export function isEntityResolver(value: GraphResolver): value is EntityResolverConfig {
  return (
    value.type === "entity" &&
    typeof (value as EntityResolverConfig).entityType === "string" &&
    typeof (value as EntityResolverConfig).entityId === "string" &&
    typeof (value as EntityResolverConfig).path === "string"
  );
}

// Shape check only — value ranges (windowMs >= 1000, alpha in (0,1]) are window-validate.ts's job.
export function isWindowResolverConfig(value: GraphResolver): value is WindowResolverConfig {
  if (value.type !== "window") return false;
  const window = value as WindowResolverConfig;
  return typeof window.sourcePropertyId === "string" && (window.kind === "tumbling" || window.kind === "ewma");
}

export function isTotalizerResolverConfig(value: GraphResolver): value is TotalizerResolverConfig {
  if (value.type !== "totalizer") return false;
  const totalizer = value as TotalizerResolverConfig;
  return typeof totalizer.sourcePropertyId === "string" && isRecord(totalizer.trigger);
}

export function parseAggState(value: unknown): AggState | null {
  if (!isRecord(value)) return null;
  if (value.sourcePropertyId !== undefined && typeof value.sourcePropertyId !== "string") return null;
  if (value.kind === "tumbling") {
    if (typeof value.bucketStart !== "number" || typeof value.bucketEnd !== "number") return null;
    if (typeof value.count !== "number" || typeof value.sum !== "number") return null;
    if (typeof value.goodCount !== "number" || typeof value.totalCount !== "number") return null;
    if (value.min !== null && typeof value.min !== "number") return null;
    if (value.max !== null && typeof value.max !== "number") return null;
    return value as unknown as TumblingState;
  }
  if (value.kind === "ewma") {
    if (typeof value.value !== "number" || typeof value.lastInputTs !== "number") return null;
    if (!isQuality(value.lastInputQuality)) return null;
    return value as unknown as EwmaState;
  }
  if (value.kind === "totalizer") {
    if (typeof value.total !== "number" || typeof value.count !== "number") return null;
    if (typeof value.lastTriggerTs !== "number") return null;
    if (!isQuality(value.lastQuality) || !isQuality(value.latestSourceQuality)) return null;
    if (value.latestSourceValue !== null && typeof value.latestSourceValue !== "number") return null;
    if (value.triggerPropertyId !== undefined && typeof value.triggerPropertyId !== "string") return null;
    if (value.resetPropertyId !== undefined && typeof value.resetPropertyId !== "string") return null;
    if (value.lastResetTs !== undefined && typeof value.lastResetTs !== "number") return null;
    if (value.lastEmitTs !== undefined && typeof value.lastEmitTs !== "number") return null;
    // State persisted before reset/lastEmitTs existed lacks those fields; default them.
    return {
      ...(value as unknown as TotalizerState),
      lastResetValue: value.lastResetValue ?? null,
      lastResetTs: typeof value.lastResetTs === "number" ? value.lastResetTs : 0,
      lastEmitTs: typeof value.lastEmitTs === "number" ? value.lastEmitTs : 0,
    };
  }
  return null;
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

// Runs on every commit (tag-input rates): decide cheaply where fields allow it
// and only fall back to structural comparison for object values/contexts.
export function envelopesEqual(a: ValueEnvelope, b: ValueEnvelope): boolean {
  if (a === b) return true;
  if (a.timestamp !== b.timestamp || a.quality !== b.quality) return false;
  if (a.value === b.value && a.context === undefined && b.context === undefined) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
