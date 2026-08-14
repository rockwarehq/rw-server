// ── Hour-close worker ────────────────────────────────────────────
// Finalizes STATION-family HOUR row families. Writes are transition-
// driven (Stage D): between transitions the open hour's duration columns
// are stale in the DB, and reads overlay them live. This worker performs
// the ONE authoritative write per hour: when a station's hour bucket
// ends, re-run the base writer with the evaluation clock pinned to the
// bucket's end (every LEAST(..., now) clips to the true hour end; counts
// are recomputed from Cycle, self-healing any increment drift), then
// stamp `closedAt` so reads stop overlaying the row.
//
// Scheduling — deterministic delayed BullMQ jobs, one per station
// (jobId `hour-close-${stationId}`), modeled on metric-buckets.ts /
// shift-change.ts:
//   * armed whenever ensureBuckets touches a station (60s ensure tick,
//     shift-boundary bucket creation, job change, …) for the hour bucket
//     containing the ensure timestamp;
//   * re-armed for the next hour after each close completes (worker
//     "completed" hook — at that point removeOnComplete has freed the
//     deterministic jobId, so the add is not deduped away).
// Close time is the row's own startTime + durationSeconds — hours are
// shift-anchored and variable-width (an 11:45 shift's first bucket
// closes at 12:45; partial boundary rows close at the boundary). NEVER
// clock-hour math.
//
// Lost jobs (Redis flush, dedup races, downtime) are covered by
// sweepOverdueHourCloses, called from the 60s ensure tick: any open row
// whose end passed more than the grace period ago is closed inline.

import { Queue, Worker } from "bullmq";
import prisma from "@rw/db";
import { bullmqConfig } from "../config.js";
import { writeStationHourBuckets } from "../metrics/cascade.js";
import { ensureBuckets } from "../metrics/bucket.js";

const HOUR_CLOSE_QUEUE = "station-hour-close";

/** A delayed job firing this far ahead of its hourEnd is re-armed, not
 *  executed — closing early would freeze durations at a future clip. */
const EARLY_FIRE_GRACE_MS = 5_000;

export interface HourClosePayload {
  siteId: string;
  stationId: string;
  /** ISO strings — BullMQ payloads are JSON. */
  hourStart: string;
  hourEnd: string;
}

let hourCloseQueue: Queue | null = null;
let hourCloseWorker: Worker | null = null;

function createConnection() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for the hour-close queue");
  return { url, connectTimeout: bullmqConfig.connectTimeout };
}

/**
 * Initialize the hour-close queue (producer side). Safe to call multiple
 * times. Processes that only *schedule* closes (apps/api via
 * ensureBuckets) call this; the worker registers in rollups.
 */
export async function initHourCloseQueue(): Promise<void> {
  if (hourCloseQueue) return;
  hourCloseQueue = new Queue(HOUR_CLOSE_QUEUE, { connection: createConnection() });
  console.log("[hour-close] queue initialized");
}

/**
 * Register the worker that processes hour-close jobs. Must be called
 * after initHourCloseQueue().
 */
export async function registerHourCloseWorker(): Promise<void> {
  if (hourCloseWorker) return;

  hourCloseWorker = new Worker(
    HOUR_CLOSE_QUEUE,
    async (job) => {
      const { siteId, stationId, hourStart, hourEnd } = job.data as HourClosePayload;
      const start = new Date(hourStart);
      const end = new Date(hourEnd);

      // Early fire (clock skew / manual enqueue): don't finalize an hour
      // that hasn't elapsed. The completed hook re-arms it.
      if (end.getTime() > Date.now() + EARLY_FIRE_GRACE_MS) {
        return { closed: false };
      }

      await closeStationHour(siteId, stationId, start, end);

      // Ensure the next hour's row family exists. ensureBuckets also
      // tries to re-arm the close, but while THIS job is active its
      // deterministic jobId is still taken — the completed hook below is
      // the reliable re-arm.
      await ensureBuckets({ siteId, entityType: "STATION", entityId: stationId, timestamp: end });

      return { closed: true };
    },
    {
      connection: createConnection(),
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  hourCloseWorker.on("completed", (job, result) => {
    const data = job.data as HourClosePayload;
    const closed = (result as { closed?: boolean } | undefined)?.closed ?? false;
    // Re-arm: for the hour containing hourEnd after a close, or the same
    // (not-yet-elapsed) hour after an early fire. removeOnComplete has
    // freed the jobId by now, so the add sticks.
    const at = closed ? new Date(data.hourEnd) : new Date(new Date(data.hourEnd).getTime() - 1);
    scheduleHourCloseAt(data.siteId, data.stationId, at).catch((err) => {
      console.error(`[hour-close] Failed to re-arm close for station ${data.stationId}:`, err);
    });
  });

  hourCloseWorker.on("failed", (job, err) => {
    console.error(`[hour-close] Job ${job?.id} failed`, err);
  });

  console.log("[hour-close] worker registered");
}

export async function stopHourCloseQueue(): Promise<void> {
  await Promise.all([hourCloseWorker?.close(), hourCloseQueue?.close()]);
  hourCloseWorker = null;
  hourCloseQueue = null;
}

// ── Close body (shared by worker + sweep) ────────────────────────

/**
 * Finalize one station-hour: base-writer recompute with the clock pinned
 * to hourEnd, then stamp closedAt on the hour's whole row family.
 * Idempotent — the recompute is from source tables and the stamp is
 * guarded by `closedAt IS NULL`, so a double fire is harmless.
 */
export async function closeStationHour(siteId: string, stationId: string, hourStart: Date, hourEnd: Date) {
  await writeStationHourBuckets(stationId, siteId, hourStart, { now: hourEnd });
  await prisma.$executeRaw`
    UPDATE "MetricBucket"
    SET "closedAt" = ${hourEnd}, "updatedAt" = NOW()
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}::uuid
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" = ${hourStart}
      AND "closedAt" IS NULL
  `;
}

// ── Scheduling ───────────────────────────────────────────────────

export interface ScheduleHourCloseInput {
  siteId: string;
  stationId: string;
  /** The bucket's own bounds (shift-anchored, variable-width). */
  hourStart: Date;
  hourEnd: Date;
}

/**
 * Arm (or re-arm) the station's single delayed close job to fire at
 * `hourEnd`. Deterministic jobId (`hour-close-${stationId}`) so repeated
 * calls replace rather than stack; a currently-active job keeps its id
 * until removeOnComplete, in which case the add is deduped away and the
 * completed hook / next ensure tick / sweep re-arms.
 */
export async function scheduleHourClose(input: ScheduleHourCloseInput): Promise<void> {
  if (!hourCloseQueue) return;

  const delay = Math.max(0, input.hourEnd.getTime() - Date.now());
  const jobId = `hour-close-${input.stationId}`;

  try {
    await hourCloseQueue.remove(jobId);
  } catch {
    // Job may not exist or may be active — both are fine
  }

  await hourCloseQueue.add(
    "close-station-hour",
    {
      siteId: input.siteId,
      stationId: input.stationId,
      hourStart: input.hourStart.toISOString(),
      hourEnd: input.hourEnd.toISOString(),
    } satisfies HourClosePayload,
    { jobId, delay, removeOnComplete: true, removeOnFail: false },
  );
}

/**
 * Arm the close for the persisted hour bucket containing `at`. Looks the
 * bucket up by its own bounds — no clock-hour assumptions. No-op when no
 * row family exists yet (ensureBuckets will arm once it scaffolds).
 */
export async function scheduleHourCloseAt(siteId: string, stationId: string, at: Date): Promise<void> {
  if (!hourCloseQueue) return;
  const rows = await prisma.$queryRaw<Array<{ hour_start: Date; hour_end: Date }>>`
    SELECT "startTime" AS hour_start,
           "startTime" + "durationSeconds" * INTERVAL '1 second' AS hour_end
    FROM "MetricBucket"
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}::uuid
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" <= ${at}::timestamptz
      AND "startTime" + "durationSeconds" * INTERVAL '1 second' > ${at}::timestamptz
    LIMIT 1
  `;
  if (rows.length === 0) return;
  await scheduleHourClose({ siteId, stationId, hourStart: rows[0].hour_start, hourEnd: rows[0].hour_end });
}

// ── Fallback sweep (lost BullMQ jobs) ────────────────────────────

/**
 * Close open STATION HOUR rows whose end passed more than `graceMs` ago
 * — the safety net for lost/deduped delayed jobs. Runs inline (no
 * queue): called from the 60s ensure tick in the rollups process. Scans
 * the partial index on open rows, so the candidate set stays tiny.
 */
export async function sweepOverdueHourCloses(graceMs = 90_000, limit = 200): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const rows = await prisma.$queryRaw<Array<{ station_id: string; site_id: string; hour_start: Date; hour_end: Date }>>`
    SELECT DISTINCT mb."entityId"::text AS station_id, s."siteId"::text AS site_id,
           mb."startTime" AS hour_start,
           mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' AS hour_end
    FROM "MetricBucket" mb
    JOIN "Station" s ON s.id = mb."entityId"
    WHERE mb."closedAt" IS NULL
      AND mb."entityType" = 'STATION'::"BucketEntityType"
      AND mb.granularity = 'HOUR'::"BucketGranularity"
      AND mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' < ${cutoff}
    ORDER BY hour_start
    LIMIT ${limit}
  `;

  let closed = 0;
  for (const row of rows) {
    try {
      await closeStationHour(row.site_id, row.station_id, row.hour_start, row.hour_end);
      closed += 1;
    } catch (err) {
      console.error(
        `[hour-close] Sweep failed to close hour ${row.hour_start.toISOString()} for station ${row.station_id}:`,
        err,
      );
    }
  }
  if (closed > 0) {
    console.log(`[hour-close] Sweep closed ${closed} overdue open hour(s)`);
  }
  return closed;
}
