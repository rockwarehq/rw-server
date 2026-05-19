// Rollups worker — runs the metric-rollup pipeline.
//
// Composes worker registrations from apps/api's source modules:
//   - metric-bucket-ensure (from queues/background-workers)
//   - shift-bucket-create (from queues/metric-buckets)
//   - shift-change (from queues/shift-change)
//   - combined metrics tick + observer (from services/metrics/batcher)
//
// At cutover, apps/api stops registering these workers in main.ts, and the
// rollups process becomes the sole consumer. Until then they overlap safely
// (BullMQ guarantees each job to exactly one worker).

import { createPrismaClient } from "@rw/db";
import { initEventsBridge } from "@rw/runtime/events-bus";
import {
  startBackgroundWorkers,
  stopBackgroundWorkers,
  scheduleNextEnsureTick,
} from "@rw/api/queues/background-workers";
import {
  initMetricBucketQueues,
  registerMetricBucketWorkers,
  stopMetricBucketQueues,
} from "@rw/api/queues/metric-buckets";
import {
  initShiftChangeQueue,
  registerShiftChangeWorker,
  stopShiftChangeQueue,
} from "@rw/api/queues/shift-change";
import { startDirtyBucketConsumer, stopDirtyBucketConsumer } from "@rw/api/services/metrics/batcher";

let cleanupBridge: (() => Promise<void>) | null = null;

export async function startRollups(): Promise<void> {
  createPrismaClient("rollups");
  cleanupBridge = await initEventsBridge("publisher");

  await initMetricBucketQueues();
  await registerMetricBucketWorkers();
  await initShiftChangeQueue();
  await registerShiftChangeWorker(scheduleNextEnsureTick);
  await startBackgroundWorkers({ skipStationEventExecution: true });
  startDirtyBucketConsumer();

  console.log("[rollups] all workers started");
}

export async function stopRollups(): Promise<void> {
  await stopDirtyBucketConsumer();
  await Promise.all([
    stopBackgroundWorkers(),
    stopMetricBucketQueues(),
    stopShiftChangeQueue(),
  ]);
  if (cleanupBridge) await cleanupBridge();
  const { createPrismaClient: getClient } = await import("@rw/db");
  await getClient("rollups").$disconnect();
}
