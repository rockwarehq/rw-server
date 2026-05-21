import { Queue, Worker } from "bullmq";
import { transitionToSlow, transitionToDown } from "../facility/station/state.js";
import { bullmqConfig } from "../config.js";

// ── Queue names ──────────────────────────────────────────────────

const SLOW_QUEUE = "station-slow-detect";
const DOWN_QUEUE = "station-down-detect";

// ── Redis connection ─────────────────────────────────────────────

function createConnection() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for station detection queues");
  return { url, connectTimeout: bullmqConfig.connectTimeout };
}

// ── Queue & Worker instances ─────────────────────────────────────

let slowQueue: Queue | null = null;
let downQueue: Queue | null = null;
let slowWorker: Worker | null = null;
let downWorker: Worker | null = null;

/**
 * Initialize BullMQ queues for station state detection.
 *
 * Creates Queue instances that can enqueue delayed jobs. Safe to call
 * multiple times — subsequent calls are a no-op.
 */
export async function initQueues() {
  if (slowQueue) return;

  const connection = createConnection();

  slowQueue = new Queue(SLOW_QUEUE, { connection });
  downQueue = new Queue(DOWN_QUEUE, { connection });

  console.log("[station-detection] queues initialized");
}

/**
 * Stop all queues and workers gracefully.
 */
export async function stopQueues() {
  await Promise.all([slowWorker?.close(), downWorker?.close(), slowQueue?.close(), downQueue?.close()]);
  slowQueue = downQueue = null;
  slowWorker = downWorker = null;
}

// ── Job processing ───────────────────────────────────────────────

/**
 * Register BullMQ workers for station state detection queues.
 *
 * Must be called after initQueues(). Workers use their own Redis
 * connection (BullMQ requirement — workers and queues cannot share
 * a single connection).
 */
export async function registerStateDetectionWorkers() {
  const connection = createConnection();

  const workerOpts = {
    connection,
    stalledInterval: bullmqConfig.stalledInterval,
    drainDelay: bullmqConfig.drainDelay,
  };

  slowWorker = new Worker(
    SLOW_QUEUE,
    async (job) => {
      const { stationId } = job.data as { stationId: string };
      const now = new Date();
      console.log(`[station-detection] slow fired for station ${stationId}`);
      await transitionToSlow(stationId, now);
    },
    workerOpts,
  );

  downWorker = new Worker(
    DOWN_QUEUE,
    async (job) => {
      const { stationId } = job.data as { stationId: string };
      const now = new Date();
      console.log(`[station-detection] down fired for station ${stationId}`);
      await transitionToDown(stationId, now);
    },
    workerOpts,
  );

  console.log("[station-detection] work handlers registered");
}

// ── Job scheduling ───────────────────────────────────────────────

/**
 * Schedule slow and downtime detection for a station.
 *
 * Removes any existing delayed jobs for the station before adding
 * new ones. BullMQ does not auto-replace jobs like pg-boss's short
 * policy — every cycle complete must cancel previous timers first.
 *
 * Jobs use deterministic IDs (`slow-{stationId}`, `down-{stationId}`)
 * so they can be reliably removed by station.
 */
export async function scheduleDetection(stationId: string, slowStartAfter: Date | null, downStartAfter: Date | null) {
  if (!slowQueue || !downQueue) return;

  // Remove existing delayed jobs for this station
  await Promise.all([slowQueue.remove(`slow-${stationId}`), downQueue.remove(`down-${stationId}`)]);

  const now = Date.now();

  if (slowStartAfter) {
    const delay = Math.max(0, slowStartAfter.getTime() - now);
    await slowQueue.add(
      "slow",
      { stationId },
      {
        jobId: `slow-${stationId}`,
        delay,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  if (downStartAfter) {
    const delay = Math.max(0, downStartAfter.getTime() - now);
    await downQueue.add(
      "down",
      { stationId },
      {
        jobId: `down-${stationId}`,
        delay,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
}

/**
 * Cancel any pending slow/downtime detection jobs for a station.
 */
export async function cancelDetection(stationId: string) {
  if (!slowQueue || !downQueue) return;

  await Promise.all([slowQueue.remove(`slow-${stationId}`), downQueue.remove(`down-${stationId}`)]);
}
