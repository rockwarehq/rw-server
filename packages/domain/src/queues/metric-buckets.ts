import { Queue, Worker } from "bullmq";
import { bullmqConfig } from "../config.js";
import { ensureBuckets } from "../services/metrics/bucket.js";
import { getShiftForEntity } from "../services/metrics/shift.js";
import { MetricsContext } from "../services/metrics/context.js";

// ── Queue names ──────────────────────────────────────────────────

const SHIFT_BUCKET_QUEUE = "shift-bucket-create";

// ── Redis connection ─────────────────────────────────────────────

function createConnection() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for metric bucket queues");
  return { url, connectTimeout: bullmqConfig.connectTimeout };
}

// ── Queue & Worker instances ─────────────────────────────────────

let shiftBucketQueue: Queue | null = null;
let shiftBucketWorker: Worker | null = null;

/**
 * Initialize BullMQ queue for shift bucket creation.
 * Safe to call multiple times — subsequent calls are a no-op.
 */
export async function initMetricBucketQueues() {
  if (shiftBucketQueue) return;

  const connection = createConnection();
  shiftBucketQueue = new Queue(SHIFT_BUCKET_QUEUE, { connection });

  console.log("[metric-buckets] queues initialized");
}

/**
 * Register the BullMQ worker that processes shift bucket creation jobs.
 * Must be called after initMetricBucketQueues().
 */
export async function registerMetricBucketWorkers() {
  const connection = createConnection();

  shiftBucketWorker = new Worker(
    SHIFT_BUCKET_QUEUE,
    async (job) => {
      const { siteId, entityType, entityId, timestamp } = job.data as {
        siteId: string;
        entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB";
        entityId: string;
        timestamp: string;
      };

      const ts = new Date(timestamp);
      console.log(`[metric-buckets] Creating shift buckets for ${entityType} ${entityId} at ${ts.toISOString()}`);

      // Share a context across ensure + schedule so shift lookups are cached
      const ctx = new MetricsContext();
      await ensureBuckets({ siteId, entityType, entityId, timestamp: ts }, ctx);

      // Schedule the next shift's bucket creation
      await scheduleNextShiftBuckets({ siteId, entityType, entityId, timestamp: ts }, ctx);
    },
    {
      connection,
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  shiftBucketWorker.on("failed", (job, err) => {
    console.error(`[metric-buckets] Shift bucket job ${job?.id} failed`, err);
  });

  console.log("[metric-buckets] workers registered");
}

/**
 * Stop all queues and workers gracefully.
 */
export async function stopMetricBucketQueues() {
  await Promise.all([shiftBucketWorker?.close(), shiftBucketQueue?.close()]);
  shiftBucketWorker = null;
  shiftBucketQueue = null;
}

// ── Job scheduling ───────────────────────────────────────────────

interface ScheduleInput {
  siteId: string;
  entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB";
  entityId: string;
  timestamp: Date;
}

/**
 * Schedule a delayed job to create buckets when the next shift starts.
 *
 * Given the current timestamp, resolves which shift we're in, computes
 * when the next shift begins (`startTime + durationSeconds`), and
 * enqueues a delayed job for that exact moment.
 *
 * Uses deterministic job IDs so repeated calls for the same entity
 * replace the previous job rather than stacking duplicates.
 */
export async function scheduleNextShiftBuckets(input: ScheduleInput, ctx?: MetricsContext) {
  if (!shiftBucketQueue) return;

  const currentShift = await getShiftForEntity(input.entityType, input.entityId, input.siteId, input.timestamp, ctx);
  if (!currentShift) return; // No shift schedule — no boundary to schedule

  const nextShiftStart = new Date(currentShift.startTime.getTime() + currentShift.durationSeconds * 1000);

  const delay = Math.max(0, nextShiftStart.getTime() - Date.now());
  const jobId = `shift-${input.entityType}-${input.entityId}`;

  // Remove any existing scheduled job for this entity
  await shiftBucketQueue.remove(jobId);

  await shiftBucketQueue.add(
    "create-shift-buckets",
    {
      siteId: input.siteId,
      entityType: input.entityType,
      entityId: input.entityId,
      timestamp: nextShiftStart.toISOString(),
    },
    {
      jobId,
      delay,
      removeOnComplete: true,
      removeOnFail: false, // Keep failed jobs for debugging
    },
  );

  console.log(
    `[metric-buckets] Scheduled next shift buckets for ${input.entityType} ${input.entityId} at ${nextShiftStart.toISOString()} (delay: ${Math.round(delay / 1000)}s)`,
  );
}
