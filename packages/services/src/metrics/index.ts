// Metrics service - public API
// Manages metric bucket computation, rollups, and recomputation

export * as bucket from "./bucket.js";
export * as shift from "./shift.js";
export * as hierarchy from "./hierarchy.js";
export * as sync from "./sync.js";
export * as compute from "./compute.js";
export * as rollup from "./rollup.js";
export * as recalc from "./recalc.js";
export * as archive from "./archive.js";

// ── Per-pipeline cache ───────────────────────────────────────────

export { MetricsContext } from "./context.js";

// ── Bucket scaffolding ───────────────────────────────────────────

export {
  ensureBuckets,
  ensureBucketsBatch,
  resolveBucket,
  getSiteTimezone,
  resolveBusinessDate,
  getLocalCalendarDate,
  type EnsureBucketsInput,
} from "./bucket.js";

// ── Archival ─────────────────────────────────────────────────────

export { archiveOldBuckets } from "./archive.js";

// ── Micro-batching ───────────────────────────────────────────────

export { batchedMetricsUpdate, type MetricsUpdateRequest } from "./batcher.js";

// ── Recomputation / update entry points ──────────────────────────

export {
  updateCountBased,
  incrementCountBased,
  processDirtyBuckets,
  updateTimeBased,
  recalcAll,
  type CycleIncrement,
} from "./recalc.js";

// ── Computation primitives ───────────────────────────────────────

export {
  computeBucketFromEvents,
  computeDurationsForBucket,
  sumKPIs,
  type BucketKPIs,
  type DurationKPIs,
  type CountKPIs,
  type JobFilter,
  ZERO_KPIS,
  KPI_KEYS,
  ADDITIVE_KPI_KEYS,
  DURATION_KPI_KEYS,
  COUNT_KPI_KEYS,
} from "./compute.js";

// ── Rollup ───────────────────────────────────────────────────────

export { rollupBuckets, type RollupInput } from "./rollup.js";

// ── Shift resolution ─────────────────────────────────────────────

export {
  getShiftForEntity,
  getShiftInstancesForRange,
  getHourBucketsForShift,
  getHourBucketsForEntity,
  getClockHourBucketsForDay,
  resolveHourBucketForEntity,
  resolveClockHourBucket,
  getLocalMidnightUTC,
  getTimezoneOffsetMs,
  clearProcessCaches,
  type ShiftWindow,
  type HourBucket,
} from "./shift.js";

// ── Hierarchy ────────────────────────────────────────────────────

export {
  getIncrementTargets,
  resolveEntityPath,
  resolveEntityName,
  type IncrementTarget,
} from "./hierarchy.js";

// ── Sync ─────────────────────────────────────────────────────────

export {
  onBucketsChanged,
  flattenChanges,
  rowToSnapshot,
  decimalToNumber,
  ZERO_SNAPSHOT,
  SNAPSHOT_KEYS,
  type BucketChange,
  type BucketSnapshot,
  type KeyValue,
} from "./sync.js";
