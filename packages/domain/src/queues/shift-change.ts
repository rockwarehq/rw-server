import { Queue, Worker } from "bullmq";
import { bullmqConfig } from "../config.js";
import { publishCurrentShiftForStations } from "../services/facility/shift/resolve-current.js";
import { flushAllExpiredShiftUsage } from "../services/inventory/material-shift-flush.js";

const SHIFT_CHANGE_QUEUE = "shift-change";

let shiftChangeQueue: Queue | null = null;
let shiftChangeWorker: Worker | null = null;

function createConnection() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for shift-change queue");
  return { url, connectTimeout: bullmqConfig.connectTimeout };
}

export async function initShiftChangeQueue() {
  if (shiftChangeQueue) return;
  shiftChangeQueue = new Queue(SHIFT_CHANGE_QUEUE, { connection: createConnection() });
  console.log("[shift-change] queue initialized");
}

/**
 * Register the shift-change worker.
 *
 * Accepts a callback to trigger the next ensure tick, breaking the
 * circular dependency with background-workers.ts.
 */
export async function registerShiftChangeWorker(triggerEnsureTick: (delayMs: number) => Promise<void>) {
  if (shiftChangeWorker) return;

  shiftChangeWorker = new Worker(
    SHIFT_CHANGE_QUEUE,
    async () => {
      const published = await publishCurrentShiftForStations();
      console.log(`[shift-change] Published currentShift for ${published} station(s)`);

      // Flush any expired shifts' staging rows into immutable PRODUCTION
      // ledger entries. Catches sites that went idle after their shift ended
      // (cycle close's lazy flush wouldn't fire for them).
      try {
        const flushed = await flushAllExpiredShiftUsage();
        const total = flushed.reduce((acc, r) => acc + r.flushedRows, 0);
        if (total > 0) {
          console.log(`[shift-change] Flushed ${total} staging rows across ${flushed.length} shift(s)`);
        }
      } catch (err) {
        console.error("[shift-change] flushAllExpiredShiftUsage failed", err);
      }

      await triggerEnsureTick(0);
    },
    {
      connection: createConnection(),
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  shiftChangeWorker.on("failed", (job, err) => {
    console.error(`[shift-change] Job ${job?.id} failed`, err);
  });

  console.log("[shift-change] worker registered");
}

export interface ShiftChangeBoundary {
  time: Date;
  scopeKey: string;
}

/**
 * Schedule shift-change delayed jobs — one per scope, for the next
 * upcoming boundary only.
 *
 * Uses deterministic job IDs so repeated calls for the same scope
 * replace the previous job rather than stacking duplicates.
 */
export async function scheduleShiftChanges(boundaries: ShiftChangeBoundary[]): Promise<void> {
  if (!shiftChangeQueue) return;

  const now = Date.now();
  for (const { time, scopeKey } of boundaries) {
    const delay = Math.max(0, time.getTime() - now);
    const jobId = `shift-change-${scopeKey}`;

    try {
      await shiftChangeQueue.remove(jobId);
    } catch {
      // Job may not exist or may be active — both fine
    }

    await shiftChangeQueue.add(
      "shift-change",
      { scopeKey, boundary: time.toISOString() },
      {
        jobId,
        delay,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  console.log(
    `[shift-change] Scheduled ${boundaries.length} boundary job(s), next in ${Math.round(Math.min(...boundaries.map((b) => b.time.getTime() - now)) / 1000)}s`,
  );
}

export async function stopShiftChangeQueue() {
  await Promise.all([shiftChangeWorker?.close(), shiftChangeQueue?.close()]);
  shiftChangeWorker = null;
  shiftChangeQueue = null;
}
