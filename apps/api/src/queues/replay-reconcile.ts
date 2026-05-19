import { Worker } from "bullmq";
import { bullmqConfig } from "../config.js";
import { reconcileReplay, REPLAY_RECONCILE_QUEUE } from "../services/cycle/replay.js";

let worker: Worker | null = null;

function createConnection() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for replay reconcile queue");
  return { url, connectTimeout: bullmqConfig.connectTimeout };
}

export async function registerReplayReconcileWorker(): Promise<void> {
  if (worker) return;

  worker = new Worker(
    REPLAY_RECONCILE_QUEUE,
    async (job) => {
      const { stationId } = job.data as { stationId: string };
      console.log(`[replay-reconcile] Starting reconciliation for station ${stationId}`);

      const start = Date.now();
      await reconcileReplay(stationId);
      console.log(`[replay-reconcile] Completed for station ${stationId} in ${Date.now() - start}ms`);
    },
    {
      connection: createConnection(),
      concurrency: 1,
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[replay-reconcile] Job ${job?.id} failed:`, err);
  });

  console.log("[replay-reconcile] Worker registered");
}

export async function stopReplayReconcileWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
