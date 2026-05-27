/**
 * @rockwarehq/metrics — Shared KPI types and OEE calculation functions.
 *
 * The OEE ratio functions mirror the PostgreSQL generated columns on
 * MetricBucket and MetricBucketLog exactly. If the SQL formulas change,
 * update the functions here to match.
 *
 * SQL source:
 *   rw-server/prisma/schema/metric.prisma (generated column comments)
 *   rw-server/prisma/migrations/20260325000000_oee_zero_not_null/migration.sql
 */

// ── Types ────────────────────────────────────────────────────────

/**
 * All KPI values for a single metric bucket.
 *
 * These are absolute values — not deltas. Every field except
 * `currentStandardCycle` is additive and can be safely summed
 * across buckets to produce rollups.
 */
export interface BucketKPIs {
  // Counting
  totalCycles: number;
  badCycles: number;
  totalItems: number;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  // Duration (integer seconds)
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  // Time (integer seconds)
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  // Elapsed (for in-progress OEE — equals full-window values for closed buckets)
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
  // Display: current job's standard cycle (seconds). null if unknown.
  // NOT additive — rollups take the latest sub-bucket's value.
  currentStandardCycle: number | null;
}

/** The subset of BucketKPIs derived from state logs (not cycles). */
export type DurationKPIs = Pick<
  BucketKPIs,
  | "runSeconds"
  | "downSeconds"
  | "plannedDownSeconds"
  | "unplannedDownSeconds"
  | "elapsedPlannedProductionSeconds"
  | "elapsedExpectedCycles"
  | "elapsedExpectedItems"
>;

/** The subset of BucketKPIs that are count-based. */
export type CountKPIs = Pick<
  BucketKPIs,
  "totalCycles" | "badCycles" | "totalItems" | "badItems" | "expectedCycles" | "expectedItems"
>;

/** Computed OEE ratio values. All may be null when there is no production window. */
export interface ComputedKPIs {
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * Keys of all additive KPI fields (summed in rollups).
 * `currentStandardCycle` is excluded — it is NOT additive.
 */
export const ADDITIVE_KPI_KEYS: ReadonlyArray<keyof BucketKPIs> = [
  "totalCycles",
  "badCycles",
  "totalItems",
  "badItems",
  "expectedCycles",
  "expectedItems",
  "runSeconds",
  "downSeconds",
  "plannedDownSeconds",
  "unplannedDownSeconds",
  "idealCycleSeconds",
  "totalCycleSeconds",
  "elapsedExpectedCycles",
  "elapsedExpectedItems",
  "elapsedPlannedProductionSeconds",
] as const;

export const DURATION_KPI_KEYS: ReadonlyArray<keyof DurationKPIs> = [
  "runSeconds",
  "downSeconds",
  "plannedDownSeconds",
  "unplannedDownSeconds",
  "elapsedPlannedProductionSeconds",
  "elapsedExpectedCycles",
  "elapsedExpectedItems",
] as const;

export const COUNT_KPI_KEYS: ReadonlyArray<keyof CountKPIs> = [
  "totalCycles",
  "badCycles",
  "totalItems",
  "badItems",
  "expectedCycles",
  "expectedItems",
] as const;

/** Zero-valued KPI set — identity element for summation. */
export const ZERO_KPIS: Readonly<BucketKPIs> = Object.freeze({
  totalCycles: 0,
  badCycles: 0,
  totalItems: 0,
  badItems: 0,
  expectedCycles: 0,
  expectedItems: 0,
  runSeconds: 0,
  downSeconds: 0,
  plannedDownSeconds: 0,
  unplannedDownSeconds: 0,
  idealCycleSeconds: 0,
  totalCycleSeconds: 0,
  elapsedExpectedCycles: 0,
  elapsedExpectedItems: 0,
  elapsedPlannedProductionSeconds: 0,
  currentStandardCycle: null,
});

// ── Summation ────────────────────────────────────────────────────

/**
 * Sum multiple BucketKPIs into a single aggregate.
 *
 * Used to derive higher granularities (SHIFT from HOURs) and higher
 * entity levels (WORKCENTER from STATIONs). After summing, call
 * `computeAllKpis()` on the result to get the derived OEE ratios.
 *
 * `currentStandardCycle` is NOT summed — the caller should handle it
 * separately (typically: take the latest sub-bucket's value).
 */
export function sumKPIs(buckets: ReadonlyArray<BucketKPIs>): BucketKPIs {
  const result = { ...ZERO_KPIS };
  for (const b of buckets) {
    for (const key of ADDITIVE_KPI_KEYS) {
      (result as Record<string, number>)[key] += (b[key] as number) ?? 0;
    }
  }
  return result;
}

// ── OEE Ratio Computation ────────────────────────────────────────
//
// These functions mirror the PostgreSQL generated columns on
// MetricBucket and MetricBucketLog. The CASE logic, NULL semantics,
// and zero-handling match the SQL exactly.
//
// SQL source: 20260325000000_oee_zero_not_null/migration.sql
//             20260311200000_widen_oee_decimal_precision/migration.sql

/**
 * Availability = runSeconds / elapsedPlannedProductionSeconds
 *
 * Returns null when there is no production window
 * (elapsedPlannedProductionSeconds = 0).
 */
export function computeAvailability(kpis: BucketKPIs): number | null {
  if (kpis.elapsedPlannedProductionSeconds <= 0) return null;
  return kpis.runSeconds / kpis.elapsedPlannedProductionSeconds;
}

/**
 * Performance = idealCycleSeconds / runSeconds
 *
 * Returns null when there is no production window.
 * Returns 0 when there is a production window but no run time.
 */
export function computePerformance(kpis: BucketKPIs): number | null {
  if (kpis.elapsedPlannedProductionSeconds <= 0) return null;
  if (kpis.runSeconds <= 0) return 0;
  return kpis.idealCycleSeconds / kpis.runSeconds;
}

/**
 * Quality = (totalItems - badItems) / totalItems
 *
 * Returns null when there is no production window.
 * Returns 0 when there is a production window but no items produced.
 */
export function computeQuality(kpis: BucketKPIs): number | null {
  if (kpis.elapsedPlannedProductionSeconds <= 0) return null;
  if (kpis.totalItems <= 0) return 0;
  return (kpis.totalItems - kpis.badItems) / kpis.totalItems;
}

/**
 * OEE = (idealCycleSeconds * (totalItems - badItems))
 *      / (elapsedPlannedProductionSeconds * totalItems)
 *
 * Equivalent to availability * performance * quality, but computed
 * directly to match the SQL generated column formula.
 *
 * Returns null when there is no production window.
 * Returns 0 when there is a production window but no items produced.
 */
export function computeOee(kpis: BucketKPIs): number | null {
  if (kpis.elapsedPlannedProductionSeconds <= 0) return null;
  if (kpis.totalItems <= 0) return 0;
  return (
    (kpis.idealCycleSeconds * (kpis.totalItems - kpis.badItems)) /
    (kpis.elapsedPlannedProductionSeconds * kpis.totalItems)
  );
}

/** Compute all four OEE ratios at once. */
export function computeAllKpis(kpis: BucketKPIs): ComputedKPIs {
  return {
    availability: computeAvailability(kpis),
    performance: computePerformance(kpis),
    quality: computeQuality(kpis),
    oee: computeOee(kpis),
  };
}
