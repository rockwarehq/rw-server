// ── Hour-row read service ────────────────────────────────────────
//
// The single aggregator over the (station, job|null, HOUR) base grain.
// Every coarser slice — shift, day, workcenter, site, job totals — is a
// SUM over hour rows computed here at read time; ratios are computed from
// the summed ingredients via the semantic catalog (never summed).
//
// Regime-proof predicates (correct before, during, and after the
// base-grain cutover and its backfill):
//   * Station scope: entityType='STATION', NO jobId predicate. Pre-cutover
//     those are whole-station rows; post-cutover they are per-job rows plus
//     the no-job residual — the SUM is identical either way.
//   * Job scope: (entityType='JOB' OR (entityType='STATION' AND jobId IS
//     NOT NULL)), deduped per (entityId, jobId, startTime) preferring the
//     STATION family. Matches legacy JOB-family rows, cutover-window rows,
//     and post-backfill rows alike.
//
// Live vs archived: rows migrate to MetricBucketLog at business-day
// rollover with the same id. Live wins on id collision (a phantom live row
// written after archival is fresher — matches the rollup pipeline's
// precedence, not the historian's archive-wins).
//
// Open-hour overlay (Stage D): writes are transition-driven, so the OPEN
// hour's duration/elapsed/expected columns in the DB go stale between
// transitions. Callers that need live values pass `overlayNow` — open
// STATION HOUR rows (closedAt IS NULL) then get those columns recomputed
// from StationStateLog × StationJobLog, clipped to
// [hourStart, min(hourEnd, now)] via the base writer's shared clipping
// CTEs (cascade.ts stationHourSliceCtes — ONE source of truth). Counts
// always come from the stored rows (they are transition-accurate).

import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { type BucketKPIs, type ComputedKPIs, computeAllKpis, ZERO_KPIS } from "@rockwarehq/metrics";
import { stationHourSliceCtes } from "./cascade.js";

export interface HourRowScope {
  /** Stations whose hour rows to aggregate. */
  stationIds: string[];
  /** Either a shiftInstanceId (exact — hour rows are shift-aligned) … */
  shiftInstanceId?: string;
  /** … or a half-open [start, end) window on startTime. */
  window?: { start: Date; end: Date };
}

export interface BucketAggregate {
  kpis: BucketKPIs;
  computed: ComputedKPIs;
  /** From the contributing row with the latest startTime. */
  currentStandardCycle: number | null;
  currentJobId: string | null;
  currentJobName: string | null;
  bucketCount: number;
  firstStartTime: Date | null;
  /** Sum of contributing rows' durationSeconds. */
  durationSeconds: number;
}

interface AggRow {
  entityId: string;
  jobId: string | null;
  totalCycles: number;
  badCycles: number;
  totalItems: number;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
  bucketCount: number;
  durationSeconds: number;
  firstStartTime: Date | null;
  currentStandardCycle: number | null;
  currentJobId: string | null;
  currentJobName: string | null;
}

const SUM_COLS = [
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

function timePredicate(scope: HourRowScope): Prisma.Sql {
  if (scope.shiftInstanceId) {
    return Prisma.sql`"shiftInstanceId" = ${scope.shiftInstanceId}::uuid`;
  }
  if (scope.window) {
    return Prisma.sql`"startTime" >= ${scope.window.start} AND "startTime" < ${scope.window.end}`;
  }
  throw new Error("HourRowScope requires shiftInstanceId or window");
}

function rowColumns(): Prisma.Sql {
  return Prisma.raw(
    `id, "entityType", "entityId", "jobId", "startTime", "durationSeconds",
     "currentStandardCycle"::double precision AS "currentStandardCycle", "currentJobId", "currentJobName",
     ${SUM_COLS.map((c) => `"${c}"`).join(", ")}`,
  );
}

/** Live∪log hour-row source with live winning id collisions. `is_live`
 *  marks the live branch so the open-hour overlay never attaches to an
 *  archived row. */
function hourSource(family: Prisma.Sql, scope: HourRowScope): Prisma.Sql {
  const time = timePredicate(scope);
  const pred = Prisma.sql`${family}
    AND "granularity" = 'HOUR'::"BucketGranularity"
    AND "entityId" = ANY(${scope.stationIds}::uuid[])
    AND ${time}`;
  return Prisma.sql`
    SELECT ${rowColumns()}, TRUE AS is_live FROM "MetricBucket" WHERE ${pred}
    UNION ALL
    SELECT ${rowColumns()}, FALSE AS is_live FROM "MetricBucketLog" l WHERE ${pred}
      AND NOT EXISTS (SELECT 1 FROM "MetricBucket" b WHERE b.id = l.id)`;
}

// ── Open-hour overlay ────────────────────────────────────────────

/** Columns the overlay recomputes live; everything else (counts,
 *  idealCycleSeconds, totalCycleSeconds) stays stored. */
export const OVERLAY_COLS = [
  "runSeconds",
  "downSeconds",
  "plannedDownSeconds",
  "unplannedDownSeconds",
  "expectedCycles",
  "expectedItems",
  "elapsedExpectedCycles",
  "elapsedExpectedItems",
  "elapsedPlannedProductionSeconds",
] as const;

/**
 * CTE fragment computing, for open STATION HOUR rows (closedAt IS NULL,
 * window already started), per (entityId, jobId|NULL) live values of the
 * duration/elapsed/expected columns, clipped to [hourStart,
 * min(hourEnd, now)] × StationJobLog windows. Reuses the base writer's
 * shared clipping CTEs — the math is identical to what the hour close
 * will eventually persist.
 *
 * Embeds as `WITH ${openHourOverlaySql(now, scope)}, ...`; the final CTE
 * is named `open_hour_overlay` with columns ("entityId", "startTime",
 * "jobId", <OVERLAY_COLS>). `scope` is an optional `AND ...` fragment
 * over the open-row scan (alias `mb`) to bound the driving set.
 */
export function openHourOverlaySql(now: Date, scope: Prisma.Sql = Prisma.empty): Prisma.Sql {
  return Prisma.sql`buckets AS (
      SELECT DISTINCT mb."entityId" AS station_id, mb."startTime" AS hour_start,
        mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' AS hour_end,
        ${now}::timestamptz AS v_now
      FROM "MetricBucket" mb
      WHERE mb."closedAt" IS NULL
        AND mb."entityType" = 'STATION'::"BucketEntityType"
        AND mb.granularity = 'HOUR'::"BucketGranularity"
        AND mb."startTime" <= ${now}::timestamptz
        ${scope}
    ),
    ${stationHourSliceCtes()},
    open_hour_overlay AS (
      SELECT js.station_id AS "entityId", js.hour_start AS "startTime", js."jobId",
        js.run_seconds AS "runSeconds",
        js.down_seconds AS "downSeconds",
        js.planned_down_seconds AS "plannedDownSeconds",
        js.unplanned_down_seconds AS "unplannedDownSeconds",
        js.expected_cycles AS "expectedCycles",
        (js.expected_cycles * js.items_per_cycle)::int AS "expectedItems",
        js.elapsed_expected_cycles AS "elapsedExpectedCycles",
        (js.elapsed_expected_cycles * js.items_per_cycle)::int AS "elapsedExpectedItems",
        js.elapsed_planned AS "elapsedPlannedProductionSeconds"
      FROM job_slice js
      UNION ALL
      SELECT rs.station_id, rs.hour_start, NULL::uuid,
        rs.run_seconds, rs.down_seconds, rs.planned_down_seconds, rs.unplanned_down_seconds,
        0, 0, 0, 0,
        (rs.run_seconds + rs.unplanned_down_seconds)::int
      FROM residual_slice rs
    )`;
}

/** Scope fragment bounding the overlay's open-row scan to this read. */
function overlayScope(scope: HourRowScope): Prisma.Sql {
  return Prisma.sql`AND mb."entityId" = ANY(${scope.stationIds}::uuid[]) AND ${timePredicate(scope)}`;
}

/**
 * Source CTEs shared by the aggregate functions: `src` exposes the hour
 * rows, with the overlay's live columns COALESCEd over stored values for
 * open live rows when `overlayNow` is set.
 */
function sourceCtes(family: Prisma.Sql, scope: HourRowScope, overlayNow?: Date): Prisma.Sql {
  if (!overlayNow) {
    return Prisma.sql`WITH src AS (${hourSource(family, scope)})`;
  }
  const coalesced = Prisma.raw(OVERLAY_COLS.map((c) => `COALESCE(o."${c}", s."${c}") AS "${c}"`).join(", "));
  return Prisma.sql`WITH ${openHourOverlaySql(overlayNow, overlayScope(scope))},
    raw_src AS (${hourSource(family, scope)}),
    src AS (
      SELECT s.id, s."entityType", s."entityId", s."jobId", s."startTime", s."durationSeconds",
        s."currentStandardCycle", s."currentJobId", s."currentJobName",
        s."totalCycles", s."badCycles", s."totalItems", s."badItems",
        s."idealCycleSeconds", s."totalCycleSeconds",
        ${coalesced}
      FROM raw_src s
      LEFT JOIN open_hour_overlay o
        ON s.is_live AND s."entityType" = 'STATION'
        AND o."entityId" = s."entityId"
        AND o."startTime" = s."startTime"
        AND o."jobId" IS NOT DISTINCT FROM s."jobId"
    )`;
}

function sumSelects(): Prisma.Sql {
  return Prisma.raw(
    `${SUM_COLS.map((c) => `COALESCE(SUM("${c}"), 0)::float8 AS "${c}"`).join(", ")},
     COUNT(*)::int AS "bucketCount",
     COALESCE(SUM("durationSeconds"), 0)::int AS "durationSeconds",
     MIN("startTime") AS "firstStartTime",
     (ARRAY_AGG("currentStandardCycle" ORDER BY "startTime" DESC))[1] AS "currentStandardCycle",
     (ARRAY_AGG("currentJobId" ORDER BY "startTime" DESC))[1] AS "currentJobId",
     (ARRAY_AGG("currentJobName" ORDER BY "startTime" DESC))[1] AS "currentJobName"`,
  );
}

function toAggregate(row: AggRow | undefined): BucketAggregate {
  if (!row) {
    return {
      kpis: { ...ZERO_KPIS },
      computed: computeAllKpis({ ...ZERO_KPIS }),
      currentStandardCycle: null,
      currentJobId: null,
      currentJobName: null,
      bucketCount: 0,
      firstStartTime: null,
      durationSeconds: 0,
    };
  }
  const kpis: BucketKPIs = {
    totalCycles: row.totalCycles,
    badCycles: row.badCycles,
    totalItems: row.totalItems,
    badItems: row.badItems,
    expectedCycles: row.expectedCycles,
    expectedItems: row.expectedItems,
    runSeconds: row.runSeconds,
    downSeconds: row.downSeconds,
    plannedDownSeconds: row.plannedDownSeconds,
    unplannedDownSeconds: row.unplannedDownSeconds,
    idealCycleSeconds: row.idealCycleSeconds,
    totalCycleSeconds: row.totalCycleSeconds,
    elapsedExpectedCycles: row.elapsedExpectedCycles,
    elapsedExpectedItems: row.elapsedExpectedItems,
    elapsedPlannedProductionSeconds: row.elapsedPlannedProductionSeconds,
    currentStandardCycle: row.currentStandardCycle,
  };
  return {
    kpis,
    computed: computeAllKpis(kpis),
    currentStandardCycle: row.currentStandardCycle,
    currentJobId: row.currentJobId,
    currentJobName: row.currentJobName,
    bucketCount: row.bucketCount,
    firstStartTime: row.firstStartTime,
    durationSeconds: row.durationSeconds,
  };
}

export interface AggregateOptions {
  /**
   * When set, open hour rows' duration/elapsed/expected columns are
   * recomputed live at this instant (see openHourOverlaySql). Pass the
   * current time for live dashboards/publishers; omit for historical
   * reads (closed/archived rows are never overlaid, so the option is
   * safe-but-wasted on purely historical scopes).
   */
  overlayNow?: Date;
}

/**
 * Per-station aggregates over the scope. Stations with no rows are present
 * in the result with a zero aggregate.
 */
export async function aggregateStationHours(
  scope: HourRowScope,
  opts?: AggregateOptions,
): Promise<Map<string, BucketAggregate>> {
  const result = new Map<string, BucketAggregate>();
  if (scope.stationIds.length === 0) return result;

  const rows = await prisma.$queryRaw<AggRow[]>`
    ${sourceCtes(Prisma.sql`"entityType" = 'STATION'::"BucketEntityType"`, scope, opts?.overlayNow)}
    SELECT "entityId", NULL::uuid AS "jobId", ${sumSelects()}
    FROM src
    GROUP BY "entityId"
  `;
  for (const id of scope.stationIds) result.set(id, toAggregate(undefined));
  for (const row of rows) result.set(row.entityId, toAggregate(row));
  return result;
}

/** One combined aggregate across all stations in the scope. */
export async function aggregateStationTotal(scope: HourRowScope, opts?: AggregateOptions): Promise<BucketAggregate> {
  if (scope.stationIds.length === 0) return toAggregate(undefined);
  const rows = await prisma.$queryRaw<AggRow[]>`
    ${sourceCtes(Prisma.sql`"entityType" = 'STATION'::"BucketEntityType"`, scope, opts?.overlayNow)}
    SELECT NULL::uuid AS "entityId", NULL::uuid AS "jobId", ${sumSelects()}
    FROM src
  `;
  return rows[0] && rows[0].bucketCount > 0 ? toAggregate(rows[0]) : toAggregate(undefined);
}

/**
 * Per-(station, job) aggregates over the scope. Optional jobId narrows to
 * one job. The no-job residual row is never included (jobId IS NOT NULL).
 */
export async function aggregateJobHours(
  scope: HourRowScope,
  jobId?: string,
  opts?: AggregateOptions,
): Promise<Map<string, BucketAggregate & { stationId: string; jobId: string }>> {
  const result = new Map<string, BucketAggregate & { stationId: string; jobId: string }>();
  if (scope.stationIds.length === 0) return result;

  const jobFilter = jobId ? Prisma.sql`AND "jobId" = ${jobId}::uuid` : Prisma.empty;
  // Both row families, deduped per (entityId, jobId, startTime) with the
  // STATION family winning — correct across the cutover and backfill.
  // The overlay attaches before the dedup: only live STATION rows can be
  // open, and those are exactly the rows the dedup prefers.
  const rows = await prisma.$queryRaw<AggRow[]>`
    ${sourceCtes(
      Prisma.sql`("entityType" = 'JOB'::"BucketEntityType"
        OR ("entityType" = 'STATION'::"BucketEntityType" AND "jobId" IS NOT NULL))`,
      scope,
      opts?.overlayNow,
    )},
    deduped AS (
      SELECT DISTINCT ON ("entityId", "jobId", "startTime") *
      FROM src
      WHERE "jobId" IS NOT NULL ${jobFilter}
      ORDER BY "entityId", "jobId", "startTime", ("entityType" = 'STATION') DESC
    )
    SELECT "entityId", "jobId", ${sumSelects()}
    FROM deduped
    GROUP BY "entityId", "jobId"
  `;
  for (const row of rows) {
    if (!row.jobId) continue;
    result.set(`${row.entityId}|${row.jobId}`, {
      ...toAggregate(row),
      stationId: row.entityId,
      jobId: row.jobId,
    });
  }
  return result;
}
