// ── Metric bucket archival ───────────────────────────────────────
// Moves completed MetricBucket rows into MetricBucketLog. A bucket
// is complete when its time window has fully elapsed:
//   startTime + durationSeconds <= now  (all UTC)
//
// This keeps the active MetricBucket table small while preserving
// historical data with snapshotted OEE columns.
//
// Called from the 60-second background worker after ensure + recalc.

import prisma from "@rw/db";
import { writeStationHourBuckets } from "./cascade.js";
import { MetricsContext } from "./context.js";

/**
 * Archive MetricBucket rows whose time window has fully elapsed.
 *
 * For each site, finds buckets where startTime + durationSeconds <= now
 * and moves them to MetricBucketLog.
 *
 * The operation is idempotent: running it multiple times won't create
 * duplicates because MetricBucketLog has the same unique constraint
 * and we use skipDuplicates.
 *
 * @returns Number of rows archived
 */
export async function archiveOldBuckets(ctx?: MetricsContext): Promise<number> {
  const sharedCtx = ctx ?? new MetricsContext();

  // Find all distinct sites that have active metric buckets
  const sites = await prisma.metricBucket.findMany({
    distinct: ["siteId"],
    select: { siteId: true },
  });

  let totalArchived = 0;

  for (const { siteId } of sites) {
    try {
      const archived = await archiveSiteBuckets(siteId, sharedCtx);
      totalArchived += archived;
    } catch (err) {
      console.error(`[metrics:archive] Failed to archive buckets for site ${siteId}:`, err);
    }
  }

  return totalArchived;
}

/**
 * Archive old buckets for a single site.
 *
 * Archives any MetricBucket row whose time window (startTime +
 * durationSeconds) has fully elapsed. All comparisons are in UTC —
 * no timezone logic needed.
 *
 * Before archiving, each distinct STATION (station, hour) family is
 * frozen with a FULL base-writer recompute (writeStationHourBuckets):
 * counts from Cycle, durations from StationStateLog, per-job expected*
 * from each job's own standardCycle and StationJobLog itemsPerCycle
 * snapshot. The old duration-only freeze existed because expected* were
 * maintained by a separate job-clipped sync the freeze could not
 * reproduce; post-Stage-C every row owns its job's values and the base
 * writer computes all of them, so the restriction's reason is gone and
 * the archived snapshot is accurate to the second across ALL columns.
 */
async function archiveSiteBuckets(siteId: string, _ctx: MetricsContext): Promise<number> {
  const now = new Date();

  // Archive buckets whose time window has fully elapsed (UTC).
  // A bucket is complete when startTime + durationSeconds <= now.
  // We first fetch candidates that started at least 24h ago (to limit
  // the query), then filter precisely by end time.
  const cutoff = new Date(now.getTime() - 86_400_000);
  const candidates = await prisma.metricBucket.findMany({
    where: {
      siteId,
      startTime: { lt: cutoff },
    },
  });

  const nowMs = now.getTime();
  const oldBuckets = candidates.filter((row) => {
    const endMs = row.startTime.getTime() + row.durationSeconds * 1000;
    return endMs <= nowMs;
  });

  if (oldBuckets.length === 0) return 0;

  // ── Freeze STATION hour families with a full recompute ──────────
  // One base-writer run per distinct (station, hour) — it rewrites the
  // whole family (per-job rows + residual) in a single statement, so
  // rows added to the family by the recompute are picked up by the
  // re-read below and archived together.
  const frozenHours = new Map<string, { stationId: string; startTime: Date }>();
  for (const bucket of oldBuckets) {
    if (bucket.entityType !== "STATION" || bucket.granularity !== "HOUR") continue;
    frozenHours.set(`${bucket.entityId}|${bucket.startTime.getTime()}`, {
      stationId: bucket.entityId,
      startTime: bucket.startTime,
    });
  }
  for (const { stationId, startTime } of frozenHours.values()) {
    try {
      await writeStationHourBuckets(stationId, siteId, startTime);
    } catch (err) {
      console.error(
        `[metrics:archive] Failed to freeze hour ${startTime.toISOString()} for station ${stationId}:`,
        err,
      );
      // Continue with archiving using the existing (potentially stale) values
    }
  }

  // Re-read the family rows for the frozen hours (the recompute may have
  // added rows) plus the remaining old buckets by id.
  const archivedIds = oldBuckets.map((row) => row.id);
  const refreshed = await prisma.metricBucket.findMany({
    where: { id: { in: archivedIds } },
  });
  const refreshedIds = new Set(refreshed.map((row) => row.id));
  const familyRows =
    frozenHours.size > 0
      ? await prisma.metricBucket.findMany({
          where: {
            siteId,
            entityType: "STATION",
            granularity: "HOUR",
            OR: [...frozenHours.values()].map(({ stationId, startTime }) => ({
              entityId: stationId,
              startTime,
            })),
          },
        })
      : [];
  const rowsToArchive = [...refreshed, ...familyRows.filter((row) => !refreshedIds.has(row.id))];

  // Copy raw (additive) fields to MetricBucketLog. Generated columns
  // (goodCycles, goodItems, plannedProductionSeconds, availability,
  // performance, quality, oee) auto-compute from the raw fields —
  // we must NOT include them in the insert data.
  const logRows = rowsToArchive.map((row) => ({
    id: row.id,
    siteId: row.siteId,
    entityType: row.entityType,
    entityId: row.entityId,
    jobId: row.jobId,
    entityName: row.entityName,
    path: row.path,
    granularity: row.granularity,
    granularityName: row.granularityName,
    startTime: row.startTime,
    durationSeconds: row.durationSeconds,
    shiftInstanceId: row.shiftInstanceId,
    businessDate: row.businessDate,
    businessShift: row.businessShift,
    totalCycles: row.totalCycles,
    expectedCycles: row.expectedCycles,
    badCycles: row.badCycles,
    totalItems: row.totalItems,
    badItems: row.badItems,
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
    currentJobId: row.currentJobId,
    currentJobName: row.currentJobName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  // Insert into log table (skipDuplicates for idempotency)
  const { count } = await prisma.metricBucketLog.createMany({
    data: logRows,
    skipDuplicates: true,
  });

  // Delete the archived rows from the active table.
  // Use the exact IDs from the archived set so we never delete
  // buckets whose time window hasn't elapsed yet (overnight shifts).
  const deleted = await prisma.metricBucket.deleteMany({
    where: { id: { in: rowsToArchive.map((row) => row.id) } },
  });

  if (count > 0 || deleted.count > 0) {
    console.log(`[metrics:archive] Site ${siteId}: archived ${count} rows, deleted ${deleted.count} from active table`);
  }

  return count;
}
