// Rollups worker — runs the entire metric-rollup pipeline.
//
//   - metric-bucket-ensure (self-chaining ~60s tick; also the fallback
//                           hour-close sweep)
//   - shift-bucket-create  (BullMQ consumer + producer)
//   - shift-change         (BullMQ delayed; triggers ensure tick at boundary)
//   - station-hour-close   (BullMQ delayed; finalizes STATION HOUR rows at
//                           each bucket's own end — writes are otherwise
//                           transition-driven)
//   - shift-instance-sweep (repeating 5m scheduler; JIT ShiftInstance safety net)
//   - shift publisher      (5s setInterval; derives + publishes the SHIFT
//                           mirror with the open hour computed in memory —
//                           publishes only, never writes)
//   - archive              (called from inside the ensure tick)
//
// All of these are tightly coupled (ensure ↔ shift-change callback, ensure ↔
// archive ↔ hour-close share MetricsContext caches, etc.) so they live in one
// node process. Each `start*` is idempotent and self-contained.

import { createPrismaClient } from "@rw/db";
import client from "prom-client";
import { initEventsBridge } from "@rw/runtime/events-bus";
import { startGraphNatsBridge } from "@rw/services/metrics/graph-nats-bridge";
import {
  startMetricBucketEnsure,
  stopMetricBucketEnsure,
  scheduleNextEnsureTick,
} from "@rw/services/queues/background-workers";
import {
  initMetricBucketQueues,
  registerMetricBucketWorkers,
  stopMetricBucketQueues,
} from "@rw/services/queues/metric-buckets";
import {
  initShiftChangeQueue,
  registerShiftChangeWorker,
  stopShiftChangeQueue,
} from "@rw/services/queues/shift-change";
import { initHourCloseQueue, registerHourCloseWorker, stopHourCloseQueue } from "@rw/services/queues/hour-close";
import { startShiftInstanceSweep, stopShiftInstanceSweep } from "@rw/services/queues/shift-instance-sweep";
import { startShiftPublisher, stopShiftPublisher } from "@rw/services/metrics/shift-publisher";

// Counts active shift assignments the sweep found with no ShiftInstance
// covering "now" — i.e. facts were silently falling back to clock-aligned
// hours until the sweep materialized the instance. Scraped via /metrics.
const shiftInstanceGapsClosed = new client.Counter({
  name: "shift_instance_sweep_gaps_closed_total",
  help: "Active shift assignments found with no ShiftInstance covering now, materialized just-in-time by the sweep",
});

let cleanupBridge: (() => Promise<void>) | null = null;
let cleanupGraphBridge: (() => Promise<void>) | null = null;

export async function startRollups(): Promise<void> {
  createPrismaClient("rollups");
  cleanupBridge = await initEventsBridge("publisher");
  cleanupGraphBridge = await startGraphNatsBridge();

  await initMetricBucketQueues();
  await registerMetricBucketWorkers();
  await initShiftChangeQueue();
  await registerShiftChangeWorker(scheduleNextEnsureTick);
  await initHourCloseQueue();
  await registerHourCloseWorker();
  await startMetricBucketEnsure();
  await startShiftInstanceSweep({
    onCoverageGapClosed: (count) => shiftInstanceGapsClosed.inc(count),
  });
  startShiftPublisher();

  console.log("[rollups] all workers started");
}

export async function stopRollups(): Promise<void> {
  await stopShiftPublisher();
  await Promise.all([
    stopMetricBucketEnsure(),
    stopMetricBucketQueues(),
    stopShiftChangeQueue(),
    stopHourCloseQueue(),
    stopShiftInstanceSweep(),
  ]);
  if (cleanupGraphBridge) await cleanupGraphBridge();
  if (cleanupBridge) await cleanupBridge();
  const { createPrismaClient: getClient } = await import("@rw/db");
  await getClient("rollups").$disconnect();
}
