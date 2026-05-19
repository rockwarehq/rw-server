// API entry point.
//
// Boots the HTTP server plus all background workers in-process. As each worker
// migrates to apps/workers in Phase 3 cutover, the corresponding init/stop
// calls below get removed (and the worker files in src/queues stop being
// referenced from this file).

// Force UTC — must be set before any Date operations or DB connections.
process.env.TZ = "UTC";

import "dotenv/config";

import { createPrismaClient } from "@rw/db";
// Eagerly initialize the API's Prisma client at the configured pool size before
// other modules pick up the shared instance.
createPrismaClient("api");

import { serverConfig } from "./config.js";
import {
  startBackgroundWorkers,
  stopBackgroundWorkers,
  scheduleNextEnsureTick,
} from "./queues/background-workers.js";
import { initQueues, registerStateDetectionWorkers, stopQueues } from "./queues/station-detection.js";
import {
  initMetricBucketQueues,
  registerMetricBucketWorkers,
  stopMetricBucketQueues,
} from "./queues/metric-buckets.js";
import { initShiftChangeQueue, registerShiftChangeWorker, stopShiftChangeQueue } from "./queues/shift-change.js";
import { createServer } from "./server.js";
import { driver } from "./services/device/index.js";
import { startDirtyBucketConsumer, stopDirtyBucketConsumer } from "./services/metrics/batcher.js";
import { registerReplayReconcileWorker, stopReplayReconcileWorker } from "./queues/replay-reconcile.js";
import { recoverReplayWindows, cleanup as cleanupReplay } from "./services/cycle/replay.js";

async function main() {
  // Initialize driver registry (load from files and sync to DB)
  await driver.driverRegistry.initialize();

  // Start HTTP listener before workers so healthchecks and RPCs respond
  // immediately. Queues are created lazily by producers, so requests that
  // arrive during worker init are safe.
  const server = createServer(serverConfig);
  await server.start();

  // All background workers run in-process for now. As each one migrates to
  // apps/workers (Phase 3 cutover per the plan), the corresponding init call
  // gets removed from this list.
  await initQueues();
  await registerStateDetectionWorkers();
  await initMetricBucketQueues();
  await registerMetricBucketWorkers();
  await initShiftChangeQueue();
  await registerShiftChangeWorker(scheduleNextEnsureTick);
  await startBackgroundWorkers();
  startDirtyBucketConsumer();
  await registerReplayReconcileWorker();
  await recoverReplayWindows();
  if (process.env.DEV_CYCLE_SIMULATOR) {
    await import("./queues/dev-cycle-simulator.js").then((m) => m.maybeStartCycleSimulator());
  }
  console.log("[api] All workers started");
}

async function shutdown() {
  await stopDirtyBucketConsumer();
  await Promise.all([
    stopBackgroundWorkers(),
    stopQueues(),
    stopMetricBucketQueues(),
    stopShiftChangeQueue(),
    stopReplayReconcileWorker(),
    cleanupReplay(),
  ]);
  const { createPrismaClient: getClient } = await import("@rw/db");
  await getClient("api").$disconnect();
}

process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  shutdown().then(() => process.exit(1));
});

main().catch((err) => {
  console.error("Failed to start server:", err);
  shutdown().then(() => process.exit(1));
});
