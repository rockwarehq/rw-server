import { Queue, Worker } from "bullmq";
import { bullmqConfig } from "../config.js";
import prisma from "../database/client.js";
import { runStationEventExecution, STATION_EVENT_EXECUTION_QUEUE } from "../services/facility/station/execution.js";
import { ensureBuckets, ensureBucketsBatch } from "../services/metrics/bucket.js";
import { archiveOldBuckets } from "../services/metrics/archive.js";
import { materializeShiftInstances } from "../services/facility/shift/materialize.js";
import { MetricsContext } from "../services/metrics/context.js";
import { jobEntityId } from "../services/metrics/cascade.js";
import { scheduleShiftChanges } from "./shift-change.js";
import { flushAllExpiredShiftUsage } from "../services/inventory/material-shift-flush.js";

const REDIS_URL = process.env.REDIS_URL;

const ENSURE_TICK_JOB_ID = "ensure-metric-buckets-next";
const ENSURE_TICK_INTERVAL_MS = 60_000;

let staleGatewayWorker: Worker | null = null;
let staleGatewayQueue: Queue | null = null;
let stationEventExecutionWorker: Worker | null = null;
let bucketEnsureWorker: Worker | null = null;
let bucketEnsureQueue: Queue | null = null;

export async function startBackgroundWorkers(options?: { skipStationEventExecution?: boolean }) {
  if (staleGatewayWorker || staleGatewayQueue || bucketEnsureWorker) {
    return;
  }

  if (!REDIS_URL) {
    console.log("[workers] REDIS_URL not set, skipping background workers");
    return;
  }

  const connection = {
    url: REDIS_URL,
    connectTimeout: bullmqConfig.connectTimeout,
  };

  staleGatewayWorker = new Worker(
    "stale-gateway-check",
    async () => {
      const cutoff = new Date(Date.now() - 60 * 1000);

      const result = await prisma.gateway.updateMany({
        where: {
          status: "ONLINE",
          lastHeartbeat: { lt: cutoff },
        },
        data: {
          status: "OFFLINE",
        },
      });

      if (result.count > 0) {
        console.log(`Marked ${result.count} gateway(s) as OFFLINE`);
      }

      return { marked: result.count };
    },
    {
      connection,
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  staleGatewayWorker.on("completed", (job, result) => {
    console.log(`Job ${job.id} completed`, result);
  });

  staleGatewayWorker.on("failed", (job, err) => {
    console.error(`Job ${job?.id} failed`, err);
  });

  staleGatewayQueue = new Queue("stale-gateway-check", { connection });
  await staleGatewayQueue.upsertJobScheduler(
    "check-stale-gateways",
    { every: 30000 },
    { name: "check-stale-gateways", opts: { removeOnComplete: true, removeOnFail: { count: 10 } } },
  );

  console.log("[workers] stale-gateway-check started");

  if (!options?.skipStationEventExecution) {
    stationEventExecutionWorker = new Worker(
      STATION_EVENT_EXECUTION_QUEUE,
      async (job) => {
        const executionId = job.data.executionId as string | undefined;
        if (!executionId) {
          throw new Error("executionId is required");
        }

        const result = await runStationEventExecution(executionId);
        if ("error" in result) {
          throw new Error(result.error);
        }

        return result.data;
      },
      {
        connection,
        concurrency: 3,
        stalledInterval: bullmqConfig.stalledInterval,
        drainDelay: bullmqConfig.drainDelay,
      },
    );

    stationEventExecutionWorker.on("completed", (job, result) => {
      console.log(`Station event job ${job.id} completed`, result);
    });

    stationEventExecutionWorker.on("failed", (job, err) => {
      console.error(`Station event job ${job?.id} failed`, err);
    });

    console.log("[workers] station-event-execution started");
  }

  // ── Metric bucket ensure (self-chaining, ~60s) ─────────────────
  // Ensures shift/hour buckets exist for all entities that already
  // have at least one bucket. Catches missed shift rollovers in case
  // the scheduled delayed job failed or was lost.
  //
  // Uses a self-chaining delayed job instead of a repeating scheduler
  // so that the shift-change worker can preempt the next tick by
  // triggering it immediately (delay: 0).
  bucketEnsureWorker = new Worker(
    "metric-bucket-ensure",
    async () => {
      try {
        return await runMetricBucketEnsureTick();
      } finally {
        await scheduleNextEnsureTick();
      }
    },
    {
      connection,
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  bucketEnsureWorker.on("failed", (job, err) => {
    console.error(`[workers] Bucket ensure job ${job?.id} failed`, err);
  });

  bucketEnsureQueue = new Queue("metric-bucket-ensure", { connection });

  // Seed the first tick immediately
  await bucketEnsureQueue.add(
    "ensure-metric-buckets",
    {},
    { jobId: ENSURE_TICK_JOB_ID, delay: 0, removeOnComplete: true, removeOnFail: { count: 10 } },
  );

  console.log("[workers] metric-bucket-ensure started (self-chaining, ~60s)");

  // Startup sweep: catch any expired-shift staging rows that didn't get
  // flushed while the process was down (cycle-close lazy flush + the
  // shift-change worker may both have been offline). Fire-and-forget so
  // boot isn't blocked on it. Same callable used by the shift-change
  // worker and any future periodic sweep.
  flushAllExpiredShiftUsage()
    .then((results) => {
      const total = results.reduce((acc, r) => acc + r.flushedRows, 0);
      if (total > 0) {
        console.log(`[workers] startup sweep flushed ${total} staging row(s) across ${results.length} shift(s)`);
      }
    })
    .catch((err) => console.error("[workers] startup material-shift flush failed:", err));
}

// ── Shared tick body + scheduling ────────────────────────────────

/**
 * Run the metric-bucket-ensure tick. Extracted so the shift-change
 * worker can also call it directly.
 */
export async function runMetricBucketEnsureTick(): Promise<{ checked: number; archived: number }> {
  const now = new Date();
  const ctx = new MetricsContext();

  // ── Materialize ShiftInstance rows (7-day lookahead) ──────────
  try {
    const { created, candidates } = await materializeShiftInstances();
    if (created > 0) {
      console.log(`[workers] Materialized ${created} shift instance(s)`);
    }

    // Schedule shift-change delayed job for the next boundary per scope
    const nowMs = now.getTime();
    const nextByScope = new Map<string, { time: Date; scopeKey: string }>();
    for (const c of candidates) {
      const scopeKey = c.workCenterId ? `wc-${c.workCenterId}` : `site-${c.siteId}`;
      for (const t of [c.startTime, c.endTime]) {
        if (t.getTime() <= nowMs) continue;
        const existing = nextByScope.get(scopeKey);
        if (!existing || t.getTime() < existing.time.getTime()) {
          nextByScope.set(scopeKey, { time: t, scopeKey });
        }
      }
    }
    if (nextByScope.size > 0) {
      await scheduleShiftChanges([...nextByScope.values()]);
    }
  } catch (err) {
    console.error("[workers] Failed to materialize shift instances:", err);
  }

  // ── Reconcile StationJobLog entries ───────────────────────────
  try {
    const stationsNeedingLog = await prisma.$queryRaw<
      Array<{
        stationId: string;
        siteId: string;
        jobId: string;
        jobBlobId: string;
        standardCycle: number | null;
        jobName: string;
      }>
    >`
      SELECT s.id AS "stationId", s."siteId", s."currentJobId" AS "jobId",
             j."currentBlobId" AS "jobBlobId", jb."standardCycle"::float8 AS "standardCycle",
             COALESCE(jb.name, '') AS "jobName"
      FROM "Station" s
      JOIN "Job" j ON j.id = s."currentJobId"
      LEFT JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
      WHERE s."currentJobId" IS NOT NULL
        AND s."deletedAt" IS NULL
        AND j."currentBlobId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "StationJobLog" sjl
          WHERE sjl."stationId" = s.id AND sjl."endTime" IS NULL
        )
    `;

    for (const station of stationsNeedingLog) {
      await prisma.$executeRaw`
        INSERT INTO "StationJobLog" (id, "stationId", "jobId", "jobBlobId", "startTime", "standardCycle", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${station.stationId}::uuid, ${station.jobId}::uuid, ${station.jobBlobId}::uuid, ${now}, ${station.standardCycle}, NOW(), NOW())
      `;
      console.log(`[workers] Reconciled missing StationJobLog for station ${station.stationId}, job ${station.jobId}`);

      await ensureBuckets(
        {
          siteId: station.siteId,
          entityType: "JOB",
          entityId: jobEntityId(station.stationId, station.jobId),
          entityName: station.jobName,
          timestamp: now,
        },
        ctx,
      );
    }
  } catch (err) {
    console.error("[workers] Failed to reconcile StationJobLog entries:", err);
  }

  // ── Ensure buckets for all active stations ─────────────────────
  // Proactively create buckets for every non-deleted station,
  // even if they have no existing buckets yet. This ensures
  // STATION buckets appear at shift start without needing a cycle.
  const allStations = await prisma.$queryRaw<Array<{ entityId: string; siteId: string; entityName: string }>>`
    SELECT s.id AS "entityId", s."siteId", s.name AS "entityName"
    FROM "Station" s
    WHERE s."deletedAt" IS NULL
  `;

  const stationInputs = allStations.map((s) => ({
    siteId: s.siteId,
    entityType: "STATION" as const,
    entityId: s.entityId,
    entityName: s.entityName,
    timestamp: now,
  }));

  if (stationInputs.length > 0) {
    await ensureBucketsBatch(stationInputs, ctx);
  }

  // ── Batch ensure buckets for all other active entities ────────
  const activeEntities = await prisma.$queryRaw<
    Array<{
      entityType: string;
      entityId: string;
      siteId: string;
    }>
  >`
    SELECT DISTINCT "entityType", "entityId", "siteId" FROM "MetricBucket"
    WHERE "entityType" != 'STATION'
  `;

  const ensureInputs = activeEntities.map((entity) => ({
    siteId: entity.siteId,
    entityType: entity.entityType as "STATION" | "WORKCENTER" | "SITE" | "JOB",
    entityId: entity.entityId,
    timestamp: now,
  }));

  await ensureBucketsBatch(ensureInputs, ctx);

  // ── Archive old buckets to MetricBucketLog ────────────────────
  let archived = 0;
  try {
    archived = await archiveOldBuckets(ctx);
  } catch (err) {
    console.error("[workers] Failed to archive old buckets:", err);
  }

  // ── Flush expired-shift staging rows into the immutable ledger ──
  // Same callable used by startup, shift-change boundary, and any future
  // dedicated periodic worker. Bounded staleness: at most 60s after a
  // shift ends without an event-driven trigger firing.
  try {
    const flushed = await flushAllExpiredShiftUsage();
    const total = flushed.reduce((acc, r) => acc + r.flushedRows, 0);
    if (total > 0) {
      console.log(`[workers] minute-tick flushed ${total} staging row(s) across ${flushed.length} shift(s)`);
    }
  } catch (err) {
    console.error("[workers] Failed to flush expired shift usage:", err);
  }

  return { checked: activeEntities.length, archived };
}

/**
 * Schedule the next metric-bucket-ensure tick.
 *
 * Uses a deterministic job ID so only one pending tick exists at a
 * time. If a tick is currently running (job ID active), the add is
 * a no-op — BullMQ won't create a duplicate.
 *
 * The shift-change worker calls this with delayMs=0 to trigger an
 * immediate tick after publishing live events.
 */
export async function scheduleNextEnsureTick(delayMs = ENSURE_TICK_INTERVAL_MS): Promise<void> {
  if (!bucketEnsureQueue) return;
  try {
    await bucketEnsureQueue.remove(ENSURE_TICK_JOB_ID);
  } catch {
    // Job may not exist or may be active — both are fine
  }
  await bucketEnsureQueue.add(
    "ensure-metric-buckets",
    {},
    { jobId: ENSURE_TICK_JOB_ID, delay: delayMs, removeOnComplete: true, removeOnFail: { count: 10 } },
  );
}

/**
 * Start only the station-event-execution worker.
 * Used by the server process when workers are split across processes.
 */
export async function startStationEventWorker() {
  if (stationEventExecutionWorker) return;

  if (!REDIS_URL) {
    console.log("[workers] REDIS_URL not set, skipping station event worker");
    return;
  }

  const connection = {
    url: REDIS_URL,
    connectTimeout: bullmqConfig.connectTimeout,
  };

  stationEventExecutionWorker = new Worker(
    STATION_EVENT_EXECUTION_QUEUE,
    async (job) => {
      const executionId = job.data.executionId as string | undefined;
      if (!executionId) {
        throw new Error("executionId is required");
      }

      const result = await runStationEventExecution(executionId);
      if ("error" in result) {
        throw new Error(result.error);
      }

      return result.data;
    },
    {
      connection,
      concurrency: 10,
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  stationEventExecutionWorker.on("completed", (job, result) => {
    console.log(`Station event job ${job.id} completed`, result);
  });

  stationEventExecutionWorker.on("failed", (job, err) => {
    console.error(`Station event job ${job?.id} failed`, err);
  });

  console.log("[workers] station-event-execution started (server process, concurrency 10)");
}

export async function stopStationEventWorker() {
  await stationEventExecutionWorker?.close();
  stationEventExecutionWorker = null;
}

export async function stopBackgroundWorkers() {
  await Promise.all([
    staleGatewayWorker?.close(),
    staleGatewayQueue?.close(),
    stationEventExecutionWorker?.close(),
    bucketEnsureWorker?.close(),
    bucketEnsureQueue?.close(),
  ]);

  staleGatewayWorker = null;
  staleGatewayQueue = null;
  stationEventExecutionWorker = null;
  bucketEnsureWorker = null;
  bucketEnsureQueue = null;
}
