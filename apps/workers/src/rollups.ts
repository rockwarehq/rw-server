// Rollups worker — runs the entire metric-rollup pipeline.
//
//   - metric-bucket-ensure (self-chaining ~60s tick)
//   - shift-bucket-create  (BullMQ consumer + producer)
//   - shift-change         (BullMQ delayed; triggers ensure tick at boundary)
//   - shift-instance-sweep (repeating 5m scheduler; JIT ShiftInstance safety net)
//   - metrics combined tick + observer (5s setInterval, dirty-bucket consumer)
//   - archive              (called from inside the ensure tick)
//
// All of these are tightly coupled (ensure ↔ shift-change callback, ensure ↔
// archive ↔ tick share MetricsContext caches, etc.) so they live in one
// node process. Each `start*` is idempotent and self-contained.

import { createPrismaClient } from "@rw/db";
import client from "prom-client";
import { initEventsBridge } from "@rw/runtime/events-bus";
import { startGraphNatsBridge } from "@rw/services/metrics/graph-nats-bridge";
import { initMetricsBridge } from "@rw/services/rpc/metrics-bus";
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
import {
  startShiftInstanceSweep,
  stopShiftInstanceSweep,
} from "@rw/services/queues/shift-instance-sweep";
import { startDirtyBucketConsumer, stopDirtyBucketConsumer } from "@rw/services/metrics/batcher";

// Counts active shift assignments the sweep found with no ShiftInstance
// covering "now" — i.e. facts were silently falling back to clock-aligned
// hours until the sweep materialized the instance. Scraped via /metrics.
const shiftInstanceGapsClosed = new client.Counter({
  name: "shift_instance_sweep_gaps_closed_total",
  help: "Active shift assignments found with no ShiftInstance covering now, materialized just-in-time by the sweep",
});

let cleanupBridge: (() => Promise<void>) | null = null;
let cleanupMetricsBridge: (() => Promise<void>) | null = null;
let cleanupGraphBridge: (() => Promise<void>) | null = null;

export async function startRollups(): Promise<void> {
  createPrismaClient("rollups");
  cleanupBridge = await initEventsBridge("publisher");
  // Bridge metric-bus events to api over Redis so frontend SSE
  // (current-shift-recap, live KPIs) reflects rollup changes.
  cleanupMetricsBridge = await initMetricsBridge("publisher");
  cleanupGraphBridge = await startGraphNatsBridge();

  await initMetricBucketQueues();
  await registerMetricBucketWorkers();
  await initShiftChangeQueue();
  await registerShiftChangeWorker(scheduleNextEnsureTick);
  await startMetricBucketEnsure();
  await startShiftInstanceSweep({
    onCoverageGapClosed: (count) => shiftInstanceGapsClosed.inc(count),
  });
  startDirtyBucketConsumer();

  console.log("[rollups] all workers started");
}

export async function stopRollups(): Promise<void> {
  await stopDirtyBucketConsumer();
  await Promise.all([
    stopMetricBucketEnsure(),
    stopMetricBucketQueues(),
    stopShiftChangeQueue(),
    stopShiftInstanceSweep(),
  ]);
  if (cleanupGraphBridge) await cleanupGraphBridge();
  if (cleanupBridge) await cleanupBridge();
  if (cleanupMetricsBridge) await cleanupMetricsBridge();
  const { createPrismaClient: getClient } = await import("@rw/db");
  await getClient("rollups").$disconnect();
}
