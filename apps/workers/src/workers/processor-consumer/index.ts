// Processor-consumer worker — runs station-event-execution (the BullMQ
// consumer currently in rw-server/src/cycle-worker.ts).
//
// Reuses apps/api's BullMQ queue init plus its dedicated station-event-execution
// worker (concurrency 10). At cutover, apps/api stops registering its own copy
// of this worker and apps/workers/processor-consumer becomes the sole consumer.

import { createPrismaClient } from "@rw/db";
import { initEventsBridge } from "@rw/runtime/events-bus";
import {
  startStationEventWorker,
  stopStationEventWorker,
} from "@rw/api/queues/background-workers";
import { initQueues, stopQueues } from "@rw/api/queues/station-detection";
import { initMetricBucketQueues, stopMetricBucketQueues } from "@rw/api/queues/metric-buckets";
import { cleanup as cleanupReplay } from "@rw/api/services/cycle/replay";

let cleanupBridge: (() => Promise<void>) | null = null;

export async function startProcessorConsumer(): Promise<void> {
  createPrismaClient("processor-consumer");
  cleanupBridge = await initEventsBridge("publisher");

  // These queues need to be initialized so scheduleDetection and
  // scheduleNextShiftBuckets can enqueue jobs from inside the worker.
  await initQueues();
  await initMetricBucketQueues();

  await startStationEventWorker();
  console.log("[processor-consumer] station-event-execution worker started");
}

export async function stopProcessorConsumer(): Promise<void> {
  await stopStationEventWorker();
  await Promise.all([stopQueues(), stopMetricBucketQueues(), cleanupReplay()]);
  if (cleanupBridge) await cleanupBridge();
  const { createPrismaClient: getClient } = await import("@rw/db");
  await getClient("processor-consumer").$disconnect();
}
