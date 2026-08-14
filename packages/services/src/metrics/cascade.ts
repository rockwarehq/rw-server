// ── CTE-based base-grain writer ──────────────────────────────────
// Single-roundtrip SQL statements that maintain the ONLY persisted
// metric grain: STATION-family HOUR rows keyed
// (entityType='STATION', entityId=stationId, jobId|NULL, 'HOUR', startTime).
//
//   * one row per job active on the station in the hour (jobId = job id,
//     path = <stationPath>.job.<jobId>)
//   * one RESIDUAL row per hour (jobId IS NULL, plain station path) that
//     carries station time/counts not attributable to any job — the
//     atomic overwrite of the legacy whole-station row.
//
// Every coarser slice (SHIFT/DAY/WORKCENTER/SITE) is derived at read
// time from these rows (see read.ts); no tier writers exist anymore.
//
// Stage D: writes are TRANSITION-DRIVEN. There is no periodic writer —
// the base writer runs on state transitions / reason assignment / job
// change (via recalc.ts) and once more at hour close (queues/
// hour-close.ts) with the evaluation clock pinned to the hour's end.
// Between transitions the OPEN hour's duration/elapsed columns in the
// DB are stale BY DESIGN; reads overlay them live (read.ts
// openHourOverlaySql) and the shift publisher computes them in memory.
//
// Entry points:
//   discoverActiveStations  — stations with an open StationStateLog entry
//                             (the shift publisher's discovery set)
//   writeStationHourBuckets — full recompute of one station-hour family
//                             (counts from Cycle, durations from
//                             StationStateLog, per-job expected*)
//   stationHourSliceCtes    — the shared clipping-math CTE chain used by
//                             both the writer and the read overlay
//   incrementHourCounts     — per-cycle hot-path increment on the
//                             (STATION, station, jobId, HOUR) row

import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { onBucketsChanged, rowToSnapshot, type BucketChange } from "./sync.js";

type TransactionClient = Prisma.TransactionClient;

/** Shape returned by RETURNING * from MetricBucket, with float8 casts. */
export interface BucketRow {
  entityType: string;
  /** Station id (per-job rows carry the job in jobId). */
  entityId: string;
  /** Job id for per-job rows, null for the residual row. Part of the bucket key. */
  jobId: string | null;
  entityName: string;
  path: string;
  granularity: string;
  granularityName: string;
  siteId: string;
  startTime: Date;
  durationSeconds: number;
  shiftInstanceId: string | null;
  businessDate: Date | null;
  businessShift: string | null;
  totalCycles: number;
  goodCycles: number | null;
  badCycles: number;
  totalItems: number;
  goodItems: number | null;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  plannedProductionSeconds: number | null;
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
  currentStandardCycle: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
  currentJobId: string | null;
  currentJobName: string | null;
}

function emitRows(rows: BucketRow[]): void {
  if (rows.length === 0) return;
  const changes: BucketChange[] = rows.map((row) => ({
    siteId: row.siteId,
    entityType: row.entityType as "STATION",
    entityId: row.entityId,
    jobId: row.jobId ?? null,
    entityName: row.entityName,
    path: row.path,
    granularity: row.granularity as "HOUR",
    granularityName: row.granularityName,
    startTime: row.startTime,
    durationSeconds: row.durationSeconds,
    shiftInstanceId: row.shiftInstanceId,
    businessDate: row.businessDate,
    businessShift: row.businessShift,
    snapshot: rowToSnapshot(row),
  }));
  onBucketsChanged(changes).catch((err) => {
    console.error("[cascade] Failed to emit bucket changes:", err);
  });
}

// ── Station discovery (publisher driver) ────────────────────────

/**
 * Stations with an open StationStateLog entry — the set the shift
 * publisher derives live SHIFT mirrors for. A station with no open state
 * row has nothing advancing (no run/down time accruing), so it is
 * skipped until it comes back.
 */
export async function discoverActiveStations(): Promise<Array<{ stationId: string; siteId: string }>> {
  const rows = await prisma.$queryRaw<Array<{ station_id: string; site_id: string }>>`
    SELECT DISTINCT ssl."stationId"::text AS station_id, s."siteId"::text AS site_id
    FROM "StationStateLog" ssl
    JOIN "Station" s ON s.id = ssl."stationId"
    WHERE ssl."endTime" IS NULL AND ssl."deletedAt" IS NULL
    ORDER BY ssl."stationId"::text
  `;
  return rows.map((r) => ({ stationId: r.station_id, siteId: r.site_id }));
}

// ── HOUR-only count increment (per-cycle hot path) ──────────────

/**
 * Atomically increment count KPIs on the (STATION, stationId, jobId,
 * HOUR) row in one statement chain. No shift lookup, no recompute.
 *
 * Scaffold-on-demand: if the per-job row doesn't exist yet, its identity
 * columns (siteId, startTime/duration, shift stamps, path base) are
 * copied from the RESIDUAL row — (STATION, stationId, jobId NULL, HOUR)
 * — which ensureBuckets scaffolds for every hour. entityName is a
 * placeholder (station name) until the base writer overwrites it with
 * the job name on its next run (a transition or the hour close).
 *
 * If neither the per-job row nor the residual row exists for the hour,
 * the increment is skipped entirely — the hour close recomputes counts
 * from Cycle, so nothing is lost.
 */
export async function incrementHourCounts(
  client: TransactionClient | typeof prisma,
  stationId: string,
  _siteId: string,
  jobId: string,
  timestamp: Date,
  cycles: number,
  items: number,
  idealSeconds: number,
  totalCycleSeconds: number,
): Promise<void> {
  const rows = await client.$queryRaw<BucketRow[]>`
    WITH upd_job AS (
      UPDATE "MetricBucket" mb
      SET "totalCycles" = mb."totalCycles" + ${cycles}::int,
          "totalItems" = mb."totalItems" + ${items}::int,
          "idealCycleSeconds" = mb."idealCycleSeconds" + ${idealSeconds}::int,
          "totalCycleSeconds" = mb."totalCycleSeconds" + ${totalCycleSeconds}::int,
          "updatedAt" = NOW()
      WHERE mb."entityType" = 'STATION'::"BucketEntityType"
        AND mb."entityId" = ${stationId}::uuid
        AND mb."jobId" = ${jobId}::uuid
        AND mb.granularity = 'HOUR'::"BucketGranularity"
        AND mb."startTime" <= ${timestamp}::timestamptz
        AND mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
      RETURNING mb.*
    ),
    -- Scaffold from the residual row when the per-job row is missing.
    -- Inserted values ARE the deltas; the ON CONFLICT arm only fires when
    -- a concurrent scaffold won the race, in which case the deltas are
    -- ADDED to the winner's row.
    ins_job AS (
      INSERT INTO "MetricBucket" (
        id, "siteId", "entityType", "entityId", "jobId", granularity, "startTime", "durationSeconds",
        "entityName", "granularityName", path,
        "shiftInstanceId", "businessDate", "businessShift",
        "currentJobId",
        "totalCycles", "totalItems", "idealCycleSeconds", "totalCycleSeconds",
        "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(), res."siteId", 'STATION'::"BucketEntityType", res."entityId", ${jobId}::uuid, 'HOUR'::"BucketGranularity", res."startTime", res."durationSeconds",
        res."entityName", 'Hour', res.path || '.job.' || ${jobId}::uuid,
        res."shiftInstanceId", res."businessDate", res."businessShift",
        ${jobId}::uuid,
        ${cycles}::int, ${items}::int, ${idealSeconds}::int, ${totalCycleSeconds}::int,
        NOW(), NOW()
      FROM "MetricBucket" res
      WHERE res."entityType" = 'STATION'::"BucketEntityType"
        AND res."entityId" = ${stationId}::uuid
        AND res."jobId" IS NULL
        AND res.granularity = 'HOUR'::"BucketGranularity"
        AND res."startTime" <= ${timestamp}::timestamptz
        AND res."startTime" + res."durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM upd_job)
      ON CONFLICT ("entityType", "entityId", "jobId", granularity, "startTime") DO UPDATE SET
        "totalCycles" = "MetricBucket"."totalCycles" + EXCLUDED."totalCycles",
        "totalItems" = "MetricBucket"."totalItems" + EXCLUDED."totalItems",
        "idealCycleSeconds" = "MetricBucket"."idealCycleSeconds" + EXCLUDED."idealCycleSeconds",
        "totalCycleSeconds" = "MetricBucket"."totalCycleSeconds" + EXCLUDED."totalCycleSeconds",
        "updatedAt" = NOW()
      RETURNING *
    )
    SELECT mb."entityType", mb."entityId"::text, mb."jobId"::text, mb."entityName", mb.path, mb.granularity::text, mb."granularityName",
           mb."siteId"::text, mb."startTime", mb."durationSeconds", mb."shiftInstanceId"::text, mb."businessDate", mb."businessShift",
           mb."totalCycles", mb."goodCycles", mb."badCycles", mb."totalItems", mb."goodItems", mb."badItems",
           mb."expectedCycles", mb."expectedItems", mb."runSeconds", mb."downSeconds",
           mb."plannedDownSeconds", mb."unplannedDownSeconds", mb."plannedProductionSeconds",
           mb."idealCycleSeconds", mb."totalCycleSeconds",
           mb."elapsedExpectedCycles", mb."elapsedExpectedItems", mb."elapsedPlannedProductionSeconds",
           mb."currentStandardCycle"::float8 AS "currentStandardCycle",
           mb.availability::float8 AS availability, mb.performance::float8 AS performance,
           mb.quality::float8 AS quality, mb.oee::float8 AS oee,
           mb."currentJobId"::text, mb."currentJobName"
    FROM upd_job mb
    UNION ALL
    SELECT mb."entityType", mb."entityId"::text, mb."jobId"::text, mb."entityName", mb.path, mb.granularity::text, mb."granularityName",
           mb."siteId"::text, mb."startTime", mb."durationSeconds", mb."shiftInstanceId"::text, mb."businessDate", mb."businessShift",
           mb."totalCycles", mb."goodCycles", mb."badCycles", mb."totalItems", mb."goodItems", mb."badItems",
           mb."expectedCycles", mb."expectedItems", mb."runSeconds", mb."downSeconds",
           mb."plannedDownSeconds", mb."unplannedDownSeconds", mb."plannedProductionSeconds",
           mb."idealCycleSeconds", mb."totalCycleSeconds",
           mb."elapsedExpectedCycles", mb."elapsedExpectedItems", mb."elapsedPlannedProductionSeconds",
           mb."currentStandardCycle"::float8 AS "currentStandardCycle",
           mb.availability::float8 AS availability, mb.performance::float8 AS performance,
           mb.quality::float8 AS quality, mb.oee::float8 AS oee,
           mb."currentJobId"::text, mb."currentJobName"
    FROM ins_job mb
  `;
  emitRows(rows);
}

// ── Shared clipping math (writer + read overlay) ────────────────

/**
 * The ONE source of truth for station-hour duration/expected clipping
 * math. Returns a comma-joined chain of CTE definitions that MUST be
 * preceded by a CTE named `buckets(station_id, hour_start, hour_end,
 * v_now)` — one row per station-hour to compute. `v_now` is the
 * evaluation clock: every open-ended interval (open state rows, open
 * job windows, the hour itself) is clipped with LEAST(hour_end, v_now).
 * The hour close pins v_now to the hour's end; live reads pass "now".
 *
 * Emitted CTEs (all keyed by (station_id, hour_start)):
 *   job_windows    — StationJobLog windows overlapping the hour
 *   jobs           — one row per job (std cycle / itemsPerCycle / version
 *                    snapshotted from the job's latest window, ADR 0007)
 *   state_slice    — StationStateLog rows overlapping the hour
 *   window_clip    — Σ per-job window seconds clipped to hour × v_now
 *   job_dur        — per-job durations clipped per (window × state row)
 *   job_slice      — assembled per-job durations + expected/elapsed
 *   station_dur    — whole-hour station durations
 *   residual_slice — station_dur minus Σ job_slice, clamped >= 0
 */
export function stationHourSliceCtes(): Prisma.Sql {
  return Prisma.sql`
    -- ALL StationJobLog windows overlapping each bucket (multi-job hours
    -- produce one per-job HOUR slice per job; a job with several windows
    -- in the hour has its windows clipped and summed).
    job_windows AS (
      SELECT b.station_id, b.hour_start, b.hour_end, b.v_now,
             sjl."jobId", sjl."jobVersionId", sjl."startTime" AS job_start,
             sjl."endTime" AS job_end, sjl."standardCycle"::float8 AS std_cycle,
             COALESCE(sjl."itemsPerCycle", 1) AS items_per_cycle
      FROM buckets b
      JOIN "StationJobLog" sjl ON sjl."stationId" = b.station_id
        AND sjl."startTime" < b.hour_end
        AND (sjl."endTime" > b.hour_start OR sjl."endTime" IS NULL)
    ),
    -- One row per (bucket, job): meta snapshotted from the job's LATEST
    -- window in the hour. items_per_cycle comes from the StationJobLog
    -- snapshot (ADR 0007) — never recomputed live.
    jobs AS (
      SELECT DISTINCT ON (jw.station_id, jw.hour_start, jw."jobId")
        jw.station_id, jw.hour_start, jw."jobId", jw."jobVersionId", jw.std_cycle, jw.items_per_cycle
      FROM job_windows jw
      ORDER BY jw.station_id, jw.hour_start, jw."jobId", jw.job_start DESC
    ),
    -- State rows overlapping each bucket. UNION splits so closed entries
    -- seek (stationId, endTime) and open entries hit the partial unique
    -- index — "OR endTime IS NULL" alone can't be seeked and forces a
    -- full per-station history scan.
    state_slice AS (
      SELECT b.station_id, b.hour_start, ssl."startTime", ssl."endTime", ssl.state, ssl."statusReasonId"
      FROM buckets b
      JOIN "StationStateLog" ssl ON ssl."stationId" = b.station_id
        AND ssl."deletedAt" IS NULL
        AND ssl."endTime" >= b.hour_start
      UNION ALL
      SELECT b.station_id, b.hour_start, ssl."startTime", ssl."endTime", ssl.state, ssl."statusReasonId"
      FROM buckets b
      JOIN "StationStateLog" ssl ON ssl."stationId" = b.station_id
        AND ssl."deletedAt" IS NULL
        AND ssl."endTime" IS NULL
    ),
    -- Per-job clipped window seconds: each window clipped to the hour and
    -- to v_now, summed per job. Feeds the expected-cycles denominator.
    window_clip AS (
      SELECT jw.station_id, jw.hour_start, jw."jobId",
        SUM(GREATEST(0, EXTRACT(EPOCH FROM (
          LEAST(jw.hour_end, jw.v_now, COALESCE(jw.job_end, jw.v_now))
          - GREATEST(jw.hour_start, jw.job_start)
        ))))::float8 AS clip_seconds
      FROM job_windows jw
      GROUP BY jw.station_id, jw.hour_start, jw."jobId"
    ),
    -- Durations clipped per (job window × state row), summed per job.
    -- LEFT JOIN so a job with no state rows in its window still gets zeros.
    job_dur AS (
      SELECT jw.station_id, jw.hour_start, jw."jobId",
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'UP' THEN EXTRACT(EPOCH FROM (
          LEAST(COALESCE(ssl."endTime", jw.v_now), LEAST(jw.hour_end, jw.v_now, COALESCE(jw.job_end, jw.v_now)))
          - GREATEST(ssl."startTime", jw.hour_start, jw.job_start)
        )) ELSE 0 END))::int, 0) AS run_seconds,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' THEN EXTRACT(EPOCH FROM (
          LEAST(COALESCE(ssl."endTime", jw.v_now), LEAST(jw.hour_end, jw.v_now, COALESCE(jw.job_end, jw.v_now)))
          - GREATEST(ssl."startTime", jw.hour_start, jw.job_start)
        )) ELSE 0 END))::int, 0) AS down_seconds,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' AND sr."isPlannedDown" = true THEN EXTRACT(EPOCH FROM (
          LEAST(COALESCE(ssl."endTime", jw.v_now), LEAST(jw.hour_end, jw.v_now, COALESCE(jw.job_end, jw.v_now)))
          - GREATEST(ssl."startTime", jw.hour_start, jw.job_start)
        )) ELSE 0 END))::int, 0) AS planned_down_seconds,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' AND (sr."isPlannedDown" IS NULL OR sr."isPlannedDown" = false) THEN EXTRACT(EPOCH FROM (
          LEAST(COALESCE(ssl."endTime", jw.v_now), LEAST(jw.hour_end, jw.v_now, COALESCE(jw.job_end, jw.v_now)))
          - GREATEST(ssl."startTime", jw.hour_start, jw.job_start)
        )) ELSE 0 END))::int, 0) AS unplanned_down_seconds
      FROM job_windows jw
      LEFT JOIN state_slice ssl
        ON ssl.station_id = jw.station_id AND ssl.hour_start = jw.hour_start
        AND ssl."startTime" < LEAST(jw.hour_end, jw.v_now, COALESCE(jw.job_end, jw.v_now))
        AND (ssl."endTime" > GREATEST(jw.hour_start, jw.job_start) OR ssl."endTime" IS NULL)
      LEFT JOIN "StatusReason" sr ON sr.id = ssl."statusReasonId"
      GROUP BY jw.station_id, jw.hour_start, jw."jobId"
    ),
    -- One assembled slice per (bucket, job). Expected cycles use
    -- summed-clip-then-FLOOR across the job's windows
    -- (FLOOR((Σclip - Σplanned_down)/std)).
    job_slice AS (
      SELECT
        j.station_id, j.hour_start, j."jobId", j."jobVersionId", j.std_cycle, j.items_per_cycle,
        COALESCE(jd.run_seconds, 0) AS run_seconds,
        COALESCE(jd.down_seconds, 0) AS down_seconds,
        COALESCE(jd.planned_down_seconds, 0) AS planned_down_seconds,
        COALESCE(jd.unplanned_down_seconds, 0) AS unplanned_down_seconds,
        COALESCE(jd.run_seconds, 0) + COALESCE(jd.unplanned_down_seconds, 0) AS elapsed_planned,
        CASE WHEN j.std_cycle > 0 THEN FLOOR(GREATEST(0, COALESCE(wc.clip_seconds, 0) - COALESCE(jd.planned_down_seconds, 0)) / j.std_cycle)::int ELSE 0 END AS expected_cycles,
        CASE WHEN j.std_cycle > 0 THEN FLOOR((COALESCE(jd.run_seconds, 0) + COALESCE(jd.unplanned_down_seconds, 0)) / j.std_cycle)::int ELSE 0 END AS elapsed_expected_cycles
      FROM jobs j
      LEFT JOIN job_dur jd ON jd.station_id = j.station_id AND jd.hour_start = j.hour_start AND jd."jobId" = j."jobId"
      LEFT JOIN window_clip wc ON wc.station_id = j.station_id AND wc.hour_start = j.hour_start AND wc."jobId" = j."jobId"
    ),
    -- Whole-hour station durations — the minuend for the residual.
    station_dur AS (
      SELECT b.station_id, b.hour_start,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'UP' THEN EXTRACT(EPOCH FROM (LEAST(COALESCE(ssl."endTime", b.v_now), LEAST(b.hour_end, b.v_now)) - GREATEST(ssl."startTime", b.hour_start))) ELSE 0 END))::int, 0) AS run_seconds,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' THEN EXTRACT(EPOCH FROM (LEAST(COALESCE(ssl."endTime", b.v_now), LEAST(b.hour_end, b.v_now)) - GREATEST(ssl."startTime", b.hour_start))) ELSE 0 END))::int, 0) AS down_seconds,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' AND sr."isPlannedDown" = true THEN EXTRACT(EPOCH FROM (LEAST(COALESCE(ssl."endTime", b.v_now), LEAST(b.hour_end, b.v_now)) - GREATEST(ssl."startTime", b.hour_start))) ELSE 0 END))::int, 0) AS planned_down_seconds,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' AND (sr."isPlannedDown" IS NULL OR sr."isPlannedDown" = false) THEN EXTRACT(EPOCH FROM (LEAST(COALESCE(ssl."endTime", b.v_now), LEAST(b.hour_end, b.v_now)) - GREATEST(ssl."startTime", b.hour_start))) ELSE 0 END))::int, 0) AS unplanned_down_seconds
      FROM buckets b
      LEFT JOIN state_slice ssl
        ON ssl.station_id = b.station_id AND ssl.hour_start = b.hour_start
        AND ssl."startTime" < LEAST(b.hour_end, b.v_now)
        AND (ssl."endTime" > b.hour_start OR ssl."endTime" IS NULL)
      LEFT JOIN "StatusReason" sr ON sr.id = ssl."statusReasonId"
      GROUP BY b.station_id, b.hour_start
    ),
    -- Residual durations = whole-hour station durations minus Σ per-job
    -- clipped durations, clamped >= 0 per column.
    residual_slice AS (
      SELECT sd.station_id, sd.hour_start,
        GREATEST(0, sd.run_seconds - COALESCE(js.run_seconds, 0))::int AS run_seconds,
        GREATEST(0, sd.down_seconds - COALESCE(js.down_seconds, 0))::int AS down_seconds,
        GREATEST(0, sd.planned_down_seconds - COALESCE(js.planned_down_seconds, 0))::int AS planned_down_seconds,
        GREATEST(0, sd.unplanned_down_seconds - COALESCE(js.unplanned_down_seconds, 0))::int AS unplanned_down_seconds
      FROM station_dur sd
      LEFT JOIN (
        SELECT station_id, hour_start,
               COALESCE(SUM(run_seconds), 0)::int AS run_seconds,
               COALESCE(SUM(down_seconds), 0)::int AS down_seconds,
               COALESCE(SUM(planned_down_seconds), 0)::int AS planned_down_seconds,
               COALESCE(SUM(unplanned_down_seconds), 0)::int AS unplanned_down_seconds
        FROM job_slice
        GROUP BY station_id, hour_start
      ) js ON js.station_id = sd.station_id AND js.hour_start = sd.hour_start
    )`;
}

// ── Base writer: full station-hour recompute ────────────────────

/**
 * Recompute the STATION-family HOUR rows for the hour containing
 * `timestamp`, for EVERY job active on the station during the hour (all
 * StationJobLog windows overlapping the hour, not just the latest).
 * Counts cycles by their stamped jobId (with a job-window fallback for
 * legacy rows) and computes durations clipped to each job's active
 * window(s) within the hour.
 *
 * Also writes the RESIDUAL row — (STATION, stationId, jobId NULL, HOUR)
 * — holding the whole-hour station durations minus the sum of all
 * per-job clipped durations (clamped >= 0 per column), plus the counts
 * of cycles/dispositions that could not be attributed to any job. The
 * residual row shares its key with the LEGACY whole-station row, so on
 * first touch the legacy row's counts and expected* are atomically
 * replaced (counts move to the per-job rows; unattributed remainder
 * stays here). The residual carries no expected*: expected and
 * elapsedExpected are 0, currentStandardCycle is NULL.
 *
 * Returns early when no STATION HOUR row family exists for the hour
 * (ensureBuckets scaffolds them; archived hours are not resurrected).
 *
 * `opts.now` pins the evaluation clock: every open-ended interval is
 * clipped with LEAST(hourEnd, now). The hour close passes the hour's own
 * end so the finalized row covers exactly [hourStart, hourEnd); callers
 * that omit it evaluate at the database's NOW().
 */
export async function writeStationHourBuckets(
  stationId: string,
  siteId: string,
  timestamp: Date,
  opts?: { now?: Date },
): Promise<void> {
  // Resolve the STATION HOUR window containing this timestamp up front so
  // its bounds can be passed into the main query as bound parameters.
  //
  // Why resolve here instead of a `target_bucket` CTE: when hour_start/hour_end
  // came from a CTE, the planner could not estimate the selectivity of
  // `Cycle."end" >= hour_start AND < hour_end`, so cycle_stats (below) scanned
  // every cycle the job had ever produced via Cycle_jobVersionId_idx and filtered
  // down. Passing the bounds as parameters lets the planner use
  // Cycle_stationId_end_idx and read only the hour's rows.
  const bucket = await prisma.$queryRaw<Array<{ hour_start: Date; hour_end: Date; duration_seconds: number }>>`
    SELECT "startTime" AS hour_start,
           "startTime" + "durationSeconds" * INTERVAL '1 second' AS hour_end,
           "durationSeconds" AS duration_seconds
    FROM "MetricBucket"
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}::uuid
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" <= ${timestamp}::timestamptz
      AND "startTime" + "durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
    LIMIT 1
  `;
  if (bucket.length === 0) return;
  const { hour_start: hourStart, hour_end: hourEnd, duration_seconds: durationSeconds } = bucket[0];

  // Evaluation clock: a pinned close time, or the DB's NOW().
  const vNowSql = opts?.now ? Prisma.sql`${opts.now}::timestamptz` : Prisma.sql`NOW()`;

  const rows = await prisma.$queryRaw<BucketRow[]>`
    WITH
    params AS (
      SELECT
        ${stationId}::uuid AS station_id,
        ${siteId}::uuid AS site_id,
        ${hourStart}::timestamptz AS hour_start,
        ${hourEnd}::timestamptz AS hour_end,
        ${durationSeconds}::int AS duration_seconds,
        ${vNowSql} AS v_now
    ),
    -- Driving set for the shared clipping-math chain (single bucket here).
    buckets AS (
      SELECT station_id, hour_start, hour_end, v_now FROM params
    ),
    ${stationHourSliceCtes()},
    -- Plain station path from the residual/legacy row (jobId IS NULL —
    -- per-job siblings carry a '.job.<id>' suffix we must not inherit).
    station_path AS (
      SELECT COALESCE(
        (SELECT mb.path FROM "MetricBucket" mb, params p
         WHERE mb."entityType" = 'STATION' AND mb."entityId" = p.station_id
           AND mb."jobId" IS NULL
           AND mb.granularity = 'HOUR' AND mb."startTime" = p.hour_start
         LIMIT 1),
        'site.' || (SELECT site_id FROM params) || '.station.' || (SELECT station_id FROM params)
      ) AS path
    ),
    station_meta AS (
      SELECT COALESCE((SELECT s.name FROM "Station" s, params p WHERE s.id = p.station_id), '') AS name
    ),
    job_meta AS (
      SELECT js.*,
        COALESCE((SELECT jb.name FROM "JobVersion" jb WHERE jb.id = js."jobVersionId"), '') AS job_name,
        (SELECT path FROM station_path) || '.job.' || js."jobId" AS job_path
      FROM job_slice js
    ),
    shift_info AS (
      SELECT si.id AS shift_id, si."startTime" AS shift_start, si."endTime" AS shift_end, si."shiftName",
             si."businessDate"
      FROM "ShiftInstance" si
      LEFT JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
      WHERE si."startTime" <= (SELECT hour_start FROM params)
        AND si."endTime" > (SELECT hour_start FROM params)
        AND si."siteId" = (SELECT site_id FROM params)
        AND (
          si."workCenterId" = (SELECT "workcenterId" FROM "Station" WHERE id = (SELECT station_id FROM params))
          OR (si."workCenterId" IS NULL AND NOT EXISTS (
            SELECT 1 FROM "ShiftInstance" si2
            WHERE si2."startTime" <= (SELECT hour_start FROM params) AND si2."endTime" > (SELECT hour_start FROM params)
              AND si2."siteId" = (SELECT site_id FROM params)
              AND si2."workCenterId" = (SELECT "workcenterId" FROM "Station" WHERE id = (SELECT station_id FROM params))
          ))
        )
      ORDER BY sa."rotationStartDate" DESC NULLS LAST LIMIT 1
    ),
    -- Count cycles per job in this hour. Attribution: the cycle's stamped
    -- jobId (authoritative since cycles are stamped at insert). Legacy rows
    -- with NULL jobId fall back to the job window containing the cycle's
    -- effective timestamp (COALESCE(end, start)). Cycles that resolve to
    -- no job at all group under job_id NULL and land on the residual row.
    cycle_stats AS (
      SELECT
        attributed.job_id AS "jobId",
        COUNT(*)::int AS total_cycles,
        COALESCE(SUM((SELECT COUNT(*)::int FROM "InventoryItem" ii WHERE ii."cycleId" = c.id)), 0)::int AS total_items,
        COALESCE(SUM(EXTRACT(EPOCH FROM (c."end" - c.start))::int), 0)::int AS total_cycle_seconds
      FROM "Cycle" c
      CROSS JOIN params p
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          c."jobId",
          (SELECT jw."jobId" FROM job_windows jw
           WHERE COALESCE(c."end", c.start) >= jw.job_start
             AND COALESCE(c."end", c.start) < COALESCE(jw.job_end, p.v_now)
           ORDER BY jw.job_start DESC LIMIT 1)
        ) AS job_id
      ) attributed
      -- Filter by station + end-range using bound parameters (not params-CTE
      -- columns, which are materialized and opaque to the planner) so the
      -- planner can estimate the range and use Cycle_stationId_end_idx.
      WHERE c."stationId" = ${stationId}::uuid
        AND c."end" IS NOT NULL
        AND c."end" >= ${hourStart}::timestamptz AND c."end" < ${hourEnd}::timestamptz
      GROUP BY attributed.job_id
    ),
    -- Sum dispositioned items per job in this hour.
    -- Attribute via three paths, in order of preference:
    --   1. ItemDispositionLog.jobId — stamped at creation (authoritative)
    --   2. ItemDispositionLog.cycleId → Cycle → JobVersion.jobId
    --   3. ItemDispositionLog.jobProductVersionId → JobProductVersion → JobProduct.jobId
    -- Dispositions where no path resolves group under job_id NULL and
    -- land on the residual row.
    disposition_stats AS (
      SELECT dj.job_id AS "jobId", COALESCE(SUM(idl."quantity")::int, 0) AS bad_items
      FROM "ItemDispositionLog" idl
      CROSS JOIN params p
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          idl."jobId",
          (SELECT jbd."jobId" FROM "Cycle" cd
             JOIN "JobVersion" jbd ON jbd.id = cd."jobVersionId"
             WHERE cd.id = idl."cycleId"),
          (SELECT jp."jobId" FROM "JobProductVersion" jpb
             JOIN "JobProduct" jp ON jp.id = jpb."jobProductId"
             WHERE jpb.id = idl."jobProductVersionId")
        ) AS job_id
      ) dj
      WHERE idl."stationId" = p.station_id
        AND idl."deletedAt" IS NULL
        AND idl."createdAt" >= p.hour_start AND idl."createdAt" < p.hour_end
      GROUP BY dj.job_id
    ),
    -- One assembled row per job: shared slice durations/expected joined
    -- with this writer's counts (cycles/dispositions).
    job_derived AS (
      SELECT
        jm."jobId", jm.job_name, jm.job_path, jm.std_cycle, jm.items_per_cycle,
        jm.run_seconds, jm.down_seconds, jm.planned_down_seconds, jm.unplanned_down_seconds,
        jm.elapsed_planned,
        COALESCE(cs.total_cycles, 0) AS total_cycles,
        COALESCE(cs.total_items, 0) AS total_items,
        COALESCE(cs.total_cycles, 0) * CASE WHEN jm.std_cycle > 0 THEN ROUND(jm.std_cycle)::int ELSE 0 END AS ideal_cycle_seconds,
        COALESCE(cs.total_cycle_seconds, 0) AS total_cycle_seconds,
        COALESCE(ds.bad_items, 0) AS bad_items,
        jm.expected_cycles, jm.elapsed_expected_cycles
      FROM job_meta jm
      LEFT JOIN cycle_stats cs ON cs."jobId" = jm."jobId"
      LEFT JOIN disposition_stats ds ON ds."jobId" = jm."jobId"
    ),
    -- Residual durations from the shared chain. Residual counts = the
    -- job_id-NULL groups of cycle_stats / disposition_stats (cycles and
    -- dispositions no attribution path could resolve).
    residual AS (
      SELECT
        rs.run_seconds, rs.down_seconds, rs.planned_down_seconds, rs.unplanned_down_seconds,
        COALESCE((SELECT cs.total_cycles FROM cycle_stats cs WHERE cs."jobId" IS NULL), 0) AS total_cycles,
        COALESCE((SELECT cs.total_items FROM cycle_stats cs WHERE cs."jobId" IS NULL), 0) AS total_items,
        COALESCE((SELECT cs.total_cycle_seconds FROM cycle_stats cs WHERE cs."jobId" IS NULL), 0) AS total_cycle_seconds,
        COALESCE((SELECT ds.bad_items FROM disposition_stats ds WHERE ds."jobId" IS NULL), 0) AS bad_items
      FROM residual_slice rs
    ),
    -- Upsert the per-job rows: (STATION, stationId, jobId, HOUR).
    -- entityName/path are overwritten on conflict so hot-path scaffolds
    -- (which copy the station's name) converge to the job's name.
    upsert_job_hour AS (
      INSERT INTO "MetricBucket" (
        id, "siteId", "entityType", "entityId", "jobId", granularity, "startTime", "durationSeconds",
        "entityName", "granularityName", path,
        "totalCycles", "badCycles", "totalItems", "badItems",
        "idealCycleSeconds", "totalCycleSeconds",
        "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
        "expectedCycles", "expectedItems", "elapsedExpectedCycles", "elapsedExpectedItems",
        "elapsedPlannedProductionSeconds", "currentStandardCycle",
        "currentJobId", "currentJobName",
        "shiftInstanceId", "businessDate", "businessShift",
        "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(), p.site_id, 'STATION'::"BucketEntityType", p.station_id, jd."jobId", 'HOUR'::"BucketGranularity", p.hour_start, p.duration_seconds,
        jd.job_name, 'Hour', jd.job_path,
        jd.total_cycles, 0, jd.total_items, jd.bad_items,
        jd.ideal_cycle_seconds, jd.total_cycle_seconds,
        jd.run_seconds, jd.down_seconds, jd.planned_down_seconds, jd.unplanned_down_seconds,
        jd.expected_cycles, jd.expected_cycles * jd.items_per_cycle,
        jd.elapsed_expected_cycles, jd.elapsed_expected_cycles * jd.items_per_cycle,
        jd.elapsed_planned, jd.std_cycle,
        jd."jobId", jd.job_name,
        si.shift_id, si."businessDate", si."shiftName",
        NOW(), NOW()
      FROM job_derived jd, params p
      LEFT JOIN shift_info si ON true
      WHERE jd."jobId" IS NOT NULL
      ON CONFLICT ("entityType", "entityId", "jobId", granularity, "startTime") DO UPDATE SET
        "entityName" = EXCLUDED."entityName", path = EXCLUDED.path,
        "totalCycles" = EXCLUDED."totalCycles", "totalItems" = EXCLUDED."totalItems",
        "badItems" = EXCLUDED."badItems",
        "idealCycleSeconds" = EXCLUDED."idealCycleSeconds", "totalCycleSeconds" = EXCLUDED."totalCycleSeconds",
        "runSeconds" = EXCLUDED."runSeconds", "downSeconds" = EXCLUDED."downSeconds",
        "plannedDownSeconds" = EXCLUDED."plannedDownSeconds", "unplannedDownSeconds" = EXCLUDED."unplannedDownSeconds",
        "expectedCycles" = EXCLUDED."expectedCycles", "expectedItems" = EXCLUDED."expectedItems",
        "elapsedExpectedCycles" = EXCLUDED."elapsedExpectedCycles", "elapsedExpectedItems" = EXCLUDED."elapsedExpectedItems",
        "elapsedPlannedProductionSeconds" = EXCLUDED."elapsedPlannedProductionSeconds",
        "currentStandardCycle" = EXCLUDED."currentStandardCycle",
        "currentJobId" = EXCLUDED."currentJobId", "currentJobName" = EXCLUDED."currentJobName",
        "updatedAt" = NOW()
      RETURNING *
    ),
    -- Residual row upsert: (STATION, stationId, jobId NULL, HOUR) — the
    -- same key the legacy whole-station row occupied, so the conflict arm
    -- is a FULL overwrite: legacy counts are replaced by the unattributed
    -- remainder (per-job counts now live on the per-job rows), durations
    -- become the unclaimed remainder, expected*/elapsedExpected* go to 0
    -- and currentStandardCycle/currentJob* to NULL (per-job rows own
    -- those). This is the "atomic overwrite of the legacy row" the
    -- Stage C cutover relies on.
    upsert_residual_hour AS (
      INSERT INTO "MetricBucket" (
        id, "siteId", "entityType", "entityId", "jobId", granularity, "startTime", "durationSeconds",
        "entityName", "granularityName", path,
        "totalCycles", "badCycles", "totalItems", "badItems",
        "idealCycleSeconds", "totalCycleSeconds",
        "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
        "expectedCycles", "expectedItems", "elapsedExpectedCycles", "elapsedExpectedItems",
        "elapsedPlannedProductionSeconds", "currentStandardCycle",
        "currentJobId", "currentJobName",
        "shiftInstanceId", "businessDate", "businessShift",
        "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(), p.site_id, 'STATION'::"BucketEntityType", p.station_id, NULL, 'HOUR'::"BucketGranularity", p.hour_start, p.duration_seconds,
        (SELECT name FROM station_meta), 'Hour', (SELECT path FROM station_path),
        r.total_cycles, 0, r.total_items, r.bad_items,
        0, r.total_cycle_seconds,
        r.run_seconds, r.down_seconds, r.planned_down_seconds, r.unplanned_down_seconds,
        0, 0, 0, 0,
        r.run_seconds + r.unplanned_down_seconds, NULL,
        NULL, NULL,
        si.shift_id, si."businessDate", si."shiftName",
        NOW(), NOW()
      FROM residual r, params p
      LEFT JOIN shift_info si ON true
      ON CONFLICT ("entityType", "entityId", "jobId", granularity, "startTime") DO UPDATE SET
        "entityName" = EXCLUDED."entityName", path = EXCLUDED.path,
        "totalCycles" = EXCLUDED."totalCycles", "totalItems" = EXCLUDED."totalItems",
        "badCycles" = EXCLUDED."badCycles", "badItems" = EXCLUDED."badItems",
        "idealCycleSeconds" = EXCLUDED."idealCycleSeconds", "totalCycleSeconds" = EXCLUDED."totalCycleSeconds",
        "runSeconds" = EXCLUDED."runSeconds", "downSeconds" = EXCLUDED."downSeconds",
        "plannedDownSeconds" = EXCLUDED."plannedDownSeconds", "unplannedDownSeconds" = EXCLUDED."unplannedDownSeconds",
        "expectedCycles" = EXCLUDED."expectedCycles", "expectedItems" = EXCLUDED."expectedItems",
        "elapsedExpectedCycles" = EXCLUDED."elapsedExpectedCycles", "elapsedExpectedItems" = EXCLUDED."elapsedExpectedItems",
        "elapsedPlannedProductionSeconds" = EXCLUDED."elapsedPlannedProductionSeconds",
        "currentStandardCycle" = EXCLUDED."currentStandardCycle",
        "currentJobId" = EXCLUDED."currentJobId", "currentJobName" = EXCLUDED."currentJobName",
        "updatedAt" = NOW()
      RETURNING *
    )
    SELECT "entityType", "entityId"::text, "jobId"::text, "entityName", path, granularity::text, "granularityName",
           "siteId"::text, "startTime", "durationSeconds", "shiftInstanceId"::text, "businessDate", "businessShift",
           "totalCycles", "goodCycles", "badCycles", "totalItems", "goodItems", "badItems",
           "expectedCycles", "expectedItems", "runSeconds", "downSeconds",
           "plannedDownSeconds", "unplannedDownSeconds", "plannedProductionSeconds",
           "idealCycleSeconds", "totalCycleSeconds",
           "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
           "currentStandardCycle"::float8 AS "currentStandardCycle",
           availability::float8 AS availability, performance::float8 AS performance,
           quality::float8 AS quality, oee::float8 AS oee,
           "currentJobId"::text, "currentJobName"
    FROM upsert_job_hour
    UNION ALL
    SELECT "entityType", "entityId"::text, "jobId"::text, "entityName", path, granularity::text, "granularityName",
           "siteId"::text, "startTime", "durationSeconds", "shiftInstanceId"::text, "businessDate", "businessShift",
           "totalCycles", "goodCycles", "badCycles", "totalItems", "goodItems", "badItems",
           "expectedCycles", "expectedItems", "runSeconds", "downSeconds",
           "plannedDownSeconds", "unplannedDownSeconds", "plannedProductionSeconds",
           "idealCycleSeconds", "totalCycleSeconds",
           "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
           "currentStandardCycle"::float8 AS "currentStandardCycle",
           availability::float8 AS availability, performance::float8 AS performance,
           quality::float8 AS quality, oee::float8 AS oee,
           "currentJobId"::text, "currentJobName"
    FROM upsert_residual_hour
  `;
  emitRows(rows);
}
