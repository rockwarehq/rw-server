// ── Recomputation / update entry points ──────────────────────────
// Public API for updating metric buckets. Everything converges on the
// single base-grain writer (cascade.ts writeStationHourBuckets), which
// recomputes the STATION-family HOUR rows (per-job + residual) for one
// station-hour from raw events. No tier writers exist — SHIFT/DAY/
// WORKCENTER/SITE are derived at read time (read.ts).
//
// updateDispositionBadItems — atomic badItems increment on the per-job
//                             (or residual) HOUR row
// updateTimeBased           — re-run the base writer for every hour a
//                             state change touched (archived hours get a
//                             duration-only log-row update)
// recalcAll                 — re-run the base writer for a time range
//
// The granularity of the "base" bucket (HOUR, 5-MINUTE, etc.) is
// determined by the shift/entity configuration. Currently HOUR.
//
// All public functions accept an optional MetricsContext for per-pipeline
// caching. When provided, repeated lookups (shifts, timezone, etc.)
// are served from the cache instead of hitting the database.

import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { computeDurationsForBucket, DURATION_KPI_KEYS, type DurationKPIs } from "./compute.js";
import { writeStationHourBuckets } from "./cascade.js";
import { resolveHourBucketForEntity } from "./shift.js";
import { onBucketsChanged, rowToSnapshot, type BucketChange } from "./sync.js";
import { ensureBuckets, getSiteTimezone } from "./bucket.js";
import { MetricsContext } from "./context.js";

// ── Types ────────────────────────────────────────────────────────

interface BucketWindow {
  startTime: Date;
  durationSeconds: number;
}

// ── Bucket range helpers ─────────────────────────────────────────

/**
 * Resolve all base-granularity bucket windows that overlap a time range.
 *
 * Walks from rangeStart to rangeEnd in bucket-sized steps, resolving
 * each bucket independently (the step size depends on the entity's
 * shift configuration at that point in time).
 */
async function getBaseBucketsForRange(
  stationId: string,
  siteId: string,
  startTime: Date,
  endTime: Date,
  timezone: string,
  ctx?: MetricsContext,
): Promise<BucketWindow[]> {
  const buckets: BucketWindow[] = [];
  const seen = new Set<number>(); // startTime ms — dedup guard
  let cursor = new Date(startTime);

  while (cursor < endTime) {
    const bucket = await resolveHourBucketForEntity("STATION", stationId, siteId, cursor, timezone, ctx);
    const startMs = bucket.startTime.getTime();

    if (!seen.has(startMs)) {
      seen.add(startMs);
      buckets.push(bucket);
    }

    // Advance cursor past this bucket
    cursor = new Date(startMs + bucket.durationSeconds * 1000);
  }

  return buckets;
}

/**
 * Resolve the single base-granularity bucket that contains a specific timestamp.
 */
export async function getBaseBucketForTimestamp(
  stationId: string,
  siteId: string,
  timestamp: Date,
  timezone: string,
  ctx?: MetricsContext,
): Promise<BucketWindow> {
  return resolveHourBucketForEntity("STATION", stationId, siteId, timestamp, timezone, ctx);
}

// ── Disposition bad-items increment ──────────────────────────────

/**
 * Atomically increment `badItems` on the STATION-family HOUR row for a
 * given timestamp. The DB-generated columns (goodItems, quality, oee)
 * update automatically. No recompute, no rollup — the hour close's
 * base-writer run recomputes badItems from ItemDispositionLog anyway,
 * so this is purely a latency optimization for the disposition fast
 * path.
 *
 * Called from: disposition log creation service (fire-and-forget).
 *
 * @param stationId - Station the disposition is attributed to
 * @param siteId - Site the station belongs to
 * @param timestamp - The log's createdAt — determines which HOUR bucket
 * @param quantity - The ItemDispositionLog.quantity to add
 * @param jobId - The log's stamped jobId. When present, the increment
 *        targets the (STATION, stationId, jobId, HOUR) row (scaffolded
 *        on demand from the residual row). When absent, it targets the
 *        (STATION, stationId, jobId NULL, HOUR) residual row.
 * @param ctx - Optional per-pipeline cache
 */
export async function updateDispositionBadItems(
  stationId: string,
  siteId: string,
  timestamp: Date,
  quantity: number,
  jobId?: string | null,
  ctx?: MetricsContext,
): Promise<void> {
  const pipelineCtx = ctx ?? new MetricsContext();

  const timezone = await getSiteTimezone(siteId, pipelineCtx);
  const baseBucket = await getBaseBucketForTimestamp(stationId, siteId, timestamp, timezone, pipelineCtx);

  // Ensure bucket rows exist (residual + open-job rows)
  await ensureBuckets({ siteId, entityType: "STATION", entityId: stationId, timestamp }, pipelineCtx);

  let liveTouched = false;
  if (jobId) {
    // Target the per-job row; scaffold it from the residual row when
    // missing (identity columns copied, entityName is a placeholder the
    // base writer overwrites on its next run — a transition or the hour
    // close). If neither the per-job row nor the residual exists live,
    // fall through to the archived branch.
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`
      WITH upd AS (
        UPDATE "MetricBucket" mb
        SET "badItems" = mb."badItems" + ${quantity}::int,
            "updatedAt" = NOW()
        WHERE mb."entityType" = 'STATION'::"BucketEntityType"
          AND mb."entityId" = ${stationId}::uuid
          AND mb."jobId" = ${jobId}::uuid
          AND mb.granularity = 'HOUR'::"BucketGranularity"
          AND mb."startTime" = ${baseBucket.startTime}
        RETURNING 1
      ),
      ins AS (
        INSERT INTO "MetricBucket" (
          id, "siteId", "entityType", "entityId", "jobId", granularity, "startTime", "durationSeconds",
          "entityName", "granularityName", path,
          "shiftInstanceId", "businessDate", "businessShift",
          "currentJobId", "badItems",
          "createdAt", "updatedAt"
        )
        SELECT
          gen_random_uuid(), res."siteId", 'STATION'::"BucketEntityType", res."entityId", ${jobId}::uuid, 'HOUR'::"BucketGranularity", res."startTime", res."durationSeconds",
          res."entityName", 'Hour', res.path || '.job.' || ${jobId}::uuid,
          res."shiftInstanceId", res."businessDate", res."businessShift",
          ${jobId}::uuid, ${quantity}::int,
          NOW(), NOW()
        FROM "MetricBucket" res
        WHERE res."entityType" = 'STATION'::"BucketEntityType"
          AND res."entityId" = ${stationId}::uuid
          AND res."jobId" IS NULL
          AND res.granularity = 'HOUR'::"BucketGranularity"
          AND res."startTime" = ${baseBucket.startTime}
          AND NOT EXISTS (SELECT 1 FROM upd)
        ON CONFLICT ("entityType", "entityId", "jobId", granularity, "startTime") DO UPDATE SET
          "badItems" = "MetricBucket"."badItems" + EXCLUDED."badItems",
          "updatedAt" = NOW()
        RETURNING 1
      )
      SELECT ((SELECT COUNT(*) FROM upd) + (SELECT COUNT(*) FROM ins))::int AS n
    `;
    liveTouched = (rows[0]?.n ?? 0) > 0;
  } else {
    // No job attribution — increment the residual row.
    const count = await prisma.$executeRaw`
      UPDATE "MetricBucket"
      SET "badItems" = "badItems" + ${quantity}::int,
          "updatedAt" = NOW()
      WHERE "entityType" = 'STATION'::"BucketEntityType"
        AND "entityId" = ${stationId}::uuid
        AND "jobId" IS NULL
        AND granularity = 'HOUR'::"BucketGranularity"
        AND "startTime" = ${baseBucket.startTime}
    `;
    liveTouched = count > 0;
  }

  if (!liveTouched) {
    // Bucket was archived — update MetricBucketLog instead. Target the
    // per-job row when it exists; legacy archives (pre-backfill) only
    // have the whole-station row (jobId NULL), so fall back to it. The
    // jobId predicate matters: post-backfill an archived hour has one
    // row per (job|NULL) at the same startTime, and a predicate-free
    // UPDATE would add the quantity to every one of them.
    let updated = 0;
    if (jobId) {
      updated = await prisma.$executeRaw`
        UPDATE "MetricBucketLog"
        SET "badItems" = "badItems" + ${quantity}::int,
            "updatedAt" = NOW()
        WHERE "entityType" = 'STATION'::"BucketEntityType"
          AND "entityId" = ${stationId}::uuid
          AND "jobId" = ${jobId}::uuid
          AND granularity = 'HOUR'::"BucketGranularity"
          AND "startTime" = ${baseBucket.startTime}
      `;
    }
    if (updated === 0) {
      await prisma.$executeRaw`
        UPDATE "MetricBucketLog"
        SET "badItems" = "badItems" + ${quantity}::int,
            "updatedAt" = NOW()
        WHERE "entityType" = 'STATION'::"BucketEntityType"
          AND "entityId" = ${stationId}::uuid
          AND "jobId" IS NULL
          AND granularity = 'HOUR'::"BucketGranularity"
          AND "startTime" = ${baseBucket.startTime}
      `;
    }
    return;
  }

  // Read back and emit full snapshots (including DB-generated quality/oee)
  await emitBaseBucketChanges(siteId, stationId, [baseBucket]);
}

// ── Duration recomputation ──────────────────────────────────────

/**
 * Recompute KPIs for a station over a time range after a state change.
 *
 * Determines which base buckets overlap the range and re-runs the base
 * writer for each live hour — a full family recompute (per-job rows +
 * residual: counts from Cycle, durations from StationStateLog, per-job
 * expected*). Hours that were already archived get a duration-only
 * update on the legacy/residual MetricBucketLog row, and any phantom
 * live rows at that hour are deleted so they can't shadow the archive
 * in the read service.
 *
 * Called from: state transitions (DOWN->UP, UP->DOWN), downtime
 * reason assignment, and the 60s background worker heartbeat.
 *
 * @param stationId - Station whose state changed
 * @param siteId - Site the station belongs to
 * @param startTime - Start of the affected range
 * @param endTime - End of the affected range
 * @param standardCycleSeconds - Standard cycle for the ARCHIVED branch's
 *        expected-cycle calc. When not provided, falls back to the
 *        archived row's own currentStandardCycle snapshot. (Live hours
 *        derive per-job standard cycles from StationJobLog.)
 * @param itemsPerCycle - Items per cycle, same archived-branch semantics.
 * @param ctx - Optional per-pipeline cache
 */
export async function updateTimeBased(
  stationId: string,
  siteId: string,
  startTime: Date,
  endTime: Date,
  standardCycleSeconds?: number | null,
  itemsPerCycle?: number,
  ctx?: MetricsContext,
): Promise<void> {
  const pipelineCtx = ctx ?? new MetricsContext();

  const timezone = await getSiteTimezone(siteId, pipelineCtx);
  const baseBuckets = await getBaseBucketsForRange(stationId, siteId, startTime, endTime, timezone, pipelineCtx);
  console.log(
    `[updateTimeBased] station=${stationId} baseBuckets=${baseBuckets.length} range=${startTime.toISOString()}..${endTime.toISOString()}`,
  );

  // Ensure bucket rows exist — but only when the buckets haven't been
  // archived yet. If rows already exist in MetricBucketLog, creating
  // new empty rows in MetricBucket would shadow the archived data.
  const archivedExistsRows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "MetricBucketLog"
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" >= ${baseBuckets[0]?.startTime ?? startTime}
    LIMIT 1
  `;
  const archivedExists = archivedExistsRows[0] ?? null;
  if (!archivedExists) {
    await ensureBuckets({ siteId, entityType: "STATION", entityId: stationId, timestamp: startTime }, pipelineCtx);
  }

  for (const bucket of baseBuckets) {
    // Archived hour? The legacy whole-station / residual row (jobId IS
    // NULL) is the duration carrier in the archive.
    const archivedRows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "MetricBucketLog"
      WHERE "entityType" = 'STATION'::"BucketEntityType"
        AND "entityId" = ${stationId}
        AND "jobId" IS NULL
        AND granularity = 'HOUR'::"BucketGranularity"
        AND "startTime" = ${bucket.startTime}
      LIMIT 1
    `;
    const archivedRow = archivedRows[0] ?? null;

    if (!archivedRow) {
      // Live hour — full family recompute (per-job + residual) + emit.
      // No-op when no bucket row family exists for the hour.
      await writeStationHourBuckets(stationId, siteId, bucket.startTime);
      continue;
    }

    // ── Archived branch: duration-only update on the log row ──────
    // Per-job archived rows are left untouched — post-archive state
    // edits are rare and the residual/legacy row is where the station's
    // duration truth lives for legacy archives.
    let stdCycle = standardCycleSeconds ?? null;
    let ipc = itemsPerCycle ?? 1;
    if (stdCycle == null && archivedRow.currentStandardCycle != null) {
      stdCycle = Number(archivedRow.currentStandardCycle);
    }
    if (itemsPerCycle == null && Number(archivedRow.totalCycles) > 0) {
      ipc = Math.round(Number(archivedRow.totalItems) / Number(archivedRow.totalCycles));
    }

    const durations = await computeDurationsForBucket(
      stationId,
      bucket.startTime,
      bucket.durationSeconds,
      stdCycle,
      ipc,
    );
    const durationData = extractDurationKPIs(durations);

    if (!isDurationUnchanged(archivedRow, durationData)) {
      console.log(
        `[updateTimeBased] archived ${bucket.startTime.toISOString()} CHANGED — updating MetricBucketLog, old: planned=${archivedRow.plannedDownSeconds} unplanned=${archivedRow.unplannedDownSeconds} elapsed=${archivedRow.elapsedPlannedProductionSeconds}`,
      );
      const updateFragments = Object.entries(durationData).map(([key, val]) =>
        val != null ? Prisma.sql`"${Prisma.raw(key)}" = ${val}` : Prisma.sql`"${Prisma.raw(key)}" = NULL`,
      );
      await prisma.$executeRaw`
        UPDATE "MetricBucketLog"
        SET ${Prisma.join(updateFragments)},
            "updatedAt" = NOW()
        WHERE "entityType" = 'STATION'::"BucketEntityType"
          AND "entityId" = ${stationId}
          AND "jobId" IS NULL
          AND granularity = 'HOUR'::"BucketGranularity"
          AND "startTime" = ${bucket.startTime}
      `;
    }

    // Remove any phantom live rows (whole family) so they can't shadow
    // the archived data in the read service (live wins id/key collisions).
    await prisma.$executeRaw`
      DELETE FROM "MetricBucket"
      WHERE "entityType" = 'STATION'::"BucketEntityType"
        AND "entityId" = ${stationId}
        AND granularity = 'HOUR'::"BucketGranularity"
        AND "startTime" = ${bucket.startTime}
    `;
  }
}

/**
 * Full recomputation of all KPIs for a station over a time range.
 *
 * Re-runs the base writer for every hour in the range: per-job rows and
 * the residual are rebuilt from raw Cycle / StationStateLog /
 * StationJobLog events and emitted. Hours whose rows were already
 * archived are skipped (the writer no-ops when no live family exists).
 *
 * This is the "nuclear" per-station option — use it when the raw events
 * themselves have changed (downtime split, job change, backfill, etc.).
 *
 * @param stationId - Station to recompute
 * @param siteId - Site the station belongs to
 * @param startTime - Start of the range to recompute
 * @param endTime - End of the range to recompute
 * @param ctx - Optional per-pipeline cache
 */
export async function recalcAll(
  stationId: string,
  siteId: string,
  startTime: Date,
  endTime: Date,
  ctx?: MetricsContext,
): Promise<void> {
  const pipelineCtx = ctx ?? new MetricsContext();

  const timezone = await getSiteTimezone(siteId, pipelineCtx);
  const baseBuckets = await getBaseBucketsForRange(stationId, siteId, startTime, endTime, timezone, pipelineCtx);

  console.log(
    `[metrics:recalc] recalcAll for station ${stationId}: ${baseBuckets.length} base buckets ` +
      `from ${startTime.toISOString()} to ${endTime.toISOString()}`,
  );

  for (const bucket of baseBuckets) {
    await writeStationHourBuckets(stationId, siteId, bucket.startTime);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Extract duration-based KPI fields plus expected cycles/items and
 * currentStandardCycle for a Prisma update.
 */
function extractDurationKPIs(
  kpis: DurationKPIs & {
    expectedCycles: number;
    expectedItems: number;
    currentStandardCycle: number | null;
  },
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const key of DURATION_KPI_KEYS) {
    result[key] = kpis[key];
  }
  result.expectedCycles = kpis.expectedCycles;
  result.expectedItems = kpis.expectedItems;
  result.currentStandardCycle = kpis.currentStandardCycle;
  return result;
}

/**
 * Check if a MetricBucket row's duration KPIs already match the new values.
 * Used to skip unnecessary writes in updateTimeBased's archived branch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isDurationUnchanged(existing: any, newData: Record<string, number | null>): boolean {
  for (const key of DURATION_KPI_KEYS) {
    if (existing[key] !== newData[key]) return false;
  }
  // Also compare expectedCycles, expectedItems, currentStandardCycle
  if (existing.expectedCycles !== newData.expectedCycles) return false;
  if (existing.expectedItems !== newData.expectedItems) return false;
  const existingStdCycle = existing.currentStandardCycle != null ? Number(existing.currentStandardCycle) : null;
  if (existingStdCycle !== newData.currentStandardCycle) return false;
  return true;
}

/**
 * Read back the STATION-family HOUR rows after a write and emit full
 * snapshots (one BucketChange per family row — per-job and residual).
 */
export async function emitBaseBucketChanges(
  siteId: string,
  stationId: string,
  baseBuckets: BucketWindow[],
): Promise<void> {
  if (baseBuckets.length === 0) return;

  const startTimes = baseBuckets.map((b) => b.startTime);

  const rows = await prisma.$queryRaw<
    Array<{
      entityType: string;
      entityId: string;
      jobId: string | null;
      entityName: string;
      path: string;
      granularity: string;
      granularityName: string;
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
    }>
  >`
    SELECT "entityType", "entityId", "jobId"::text, "entityName", path,
           granularity, "granularityName", "startTime", "durationSeconds",
           "shiftInstanceId", "businessDate", "businessShift",
           "totalCycles", "goodCycles", "badCycles",
           "totalItems", "goodItems", "badItems",
           "expectedCycles", "expectedItems",
           "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
           "plannedProductionSeconds",
           "idealCycleSeconds", "totalCycleSeconds",
           "elapsedExpectedCycles", "elapsedExpectedItems",
           "elapsedPlannedProductionSeconds",
           "currentStandardCycle"::float8 AS "currentStandardCycle",
           availability::float8 AS availability,
           performance::float8 AS performance,
           quality::float8 AS quality,
           oee::float8 AS oee,
           "currentJobId", "currentJobName"
    FROM "MetricBucket"
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" IN (${Prisma.join(startTimes)})
  `;

  if (rows.length === 0) return;

  const changes: BucketChange[] = rows.map((row) => ({
    siteId,
    entityType: "STATION",
    entityId: row.entityId,
    jobId: row.jobId ?? null,
    entityName: row.entityName,
    path: row.path,
    granularity: "HOUR",
    granularityName: row.granularityName,
    startTime: row.startTime,
    durationSeconds: row.durationSeconds,
    shiftInstanceId: row.shiftInstanceId ?? null,
    businessDate: row.businessDate ?? null,
    businessShift: row.businessShift ?? null,
    snapshot: rowToSnapshot(row),
  }));

  onBucketsChanged(changes).catch((err) => {
    console.error("[metrics:recalc] Failed to notify base bucket changes:", err);
  });
}
