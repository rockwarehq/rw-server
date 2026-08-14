// ── Shift publisher (compute-at-publish SHIFT mirror) ───────────
// SHIFT-tier rows are no longer persisted; the livestore mirror
// (graphMetricSink → graph-nats-bridge, MIRRORED_GRANULARITY="SHIFT")
// still consumes BucketChange events with granularity "SHIFT". This
// module derives those events at publish time: per active station it
// resolves the current shift, sums the station's STATION-family hour
// rows for that shiftInstanceId via the read service — with the
// open-hour overlay so the current hour's durations are computed live —
// and publishes a BucketChange-shaped snapshot through
// publishMetricChange so the existing bridge flows unchanged.
//
// This module also hosts the publish interval (startShiftPublisher,
// every ~5s), the ONLY periodic loop left in the metrics pipeline.
//
// INVARIANT (Stage D write model): the interval publishes but never
// writes. Duration-based KPIs (runSeconds, availability, OEE, …) still
// advance with wall time — not because anything persists them, but
// because every publish/read recomputes the OPEN hour from
// StationStateLog at "now" (read.ts openHourOverlaySql). Persisted rows
// are written ONLY by transitions (state change, reason assign, job
// change, disposition, per-cycle count increments) and finalized once by
// the hour close (queues/hour-close.ts) with the clock pinned to the
// hour's end. Do NOT reintroduce a periodic writer; if publish values
// look stale, fix the overlay or the transition wiring instead.

import { classifyDbTimeout } from "@rw/db";
import { discoverActiveStations } from "./cascade.js";
import { getShiftForEntity, type ShiftWindow } from "./shift.js";
import { aggregateStationHours, type BucketAggregate } from "./read.js";
import { resolveEntityName, resolveEntityPath } from "./hierarchy.js";
import { MetricsContext } from "./context.js";
import { publishMetricChange } from "../rpc/metrics-bus.js";
import type { BucketChange, BucketSnapshot } from "./sync.js";

/**
 * Last snapshot published per station (serialized). Publishing is
 * skipped when nothing changed, keeping the NATS stream quiet for idle
 * stations — the mirror is a KV-style last-value store, so consumers
 * never miss anything by the skip.
 */
const lastPublished = new Map<string, string>();

/** Test/ops hook: forget the dedup cache (forces a full re-publish). */
export function clearShiftPublisherCache(): void {
  lastPublished.clear();
}

/**
 * Map a read-service aggregate onto the BucketSnapshot wire shape.
 * The four ratios come from the aggregate's `computed` block (recomputed
 * from summed ingredients — never summed); goodCycles/goodItems/
 * plannedProductionSeconds mirror the DB generated columns.
 */
function aggregateToSnapshot(agg: BucketAggregate, shift: ShiftWindow): BucketSnapshot {
  const k = agg.kpis;
  return {
    totalCycles: k.totalCycles,
    goodCycles: k.totalCycles - k.badCycles,
    badCycles: k.badCycles,
    totalItems: k.totalItems,
    goodItems: k.totalItems - k.badItems,
    badItems: k.badItems,
    expectedCycles: k.expectedCycles,
    expectedItems: k.expectedItems,
    runSeconds: k.runSeconds,
    downSeconds: k.downSeconds,
    plannedDownSeconds: k.plannedDownSeconds,
    unplannedDownSeconds: k.unplannedDownSeconds,
    plannedProductionSeconds: agg.durationSeconds - k.plannedDownSeconds,
    idealCycleSeconds: k.idealCycleSeconds,
    totalCycleSeconds: k.totalCycleSeconds,
    elapsedExpectedCycles: k.elapsedExpectedCycles,
    elapsedExpectedItems: k.elapsedExpectedItems,
    elapsedPlannedProductionSeconds: k.elapsedPlannedProductionSeconds,
    currentStandardCycle: agg.currentStandardCycle,
    availability: agg.computed.availability,
    performance: agg.computed.performance,
    quality: agg.computed.quality,
    oee: agg.computed.oee,
    shiftInstanceId: shift.shiftInstanceId,
    businessDate: shift.businessDate ? shift.businessDate.toISOString().slice(0, 10) : null,
    businessShift: shift.shiftName,
    currentJobId: agg.currentJobId,
    currentJobName: agg.currentJobName,
  };
}

/**
 * Publish derived SHIFT aggregates for the given stations (the tick's
 * discovery set). Stations without a current shift are skipped; so are
 * stations whose snapshot is identical to the last published one.
 */
export async function publishShiftAggregates(
  stations: Array<{ stationId: string; siteId: string }>,
  timestamp: Date,
): Promise<void> {
  if (stations.length === 0) return;
  const ctx = new MetricsContext();

  // Resolve each station's current shift, then batch the hour-row
  // aggregation: one read-service call per distinct shift instance.
  const shiftByStation = new Map<string, ShiftWindow>();
  const stationsByShift = new Map<string, string[]>();
  for (const { stationId, siteId } of stations) {
    try {
      const shift = await getShiftForEntity("STATION", stationId, siteId, timestamp, ctx);
      if (!shift) continue;
      shiftByStation.set(stationId, shift);
      const list = stationsByShift.get(shift.shiftInstanceId) ?? [];
      list.push(stationId);
      stationsByShift.set(shift.shiftInstanceId, list);
    } catch (err) {
      console.error(`[shift-publisher] Shift resolution failed for station ${stationId}:`, err);
    }
  }
  if (stationsByShift.size === 0) return;

  // overlayNow: the open hour's duration/elapsed columns are computed
  // live at publish time — elapsed advances every tick with zero DB
  // writes (the whole point of the Stage D model).
  const aggsByShift = new Map<string, Map<string, BucketAggregate>>();
  for (const [shiftInstanceId, stationIds] of stationsByShift) {
    try {
      aggsByShift.set(
        shiftInstanceId,
        await aggregateStationHours({ stationIds, shiftInstanceId }, { overlayNow: timestamp }),
      );
    } catch (err) {
      console.error(`[shift-publisher] Hour aggregation failed for shift ${shiftInstanceId}:`, err);
    }
  }

  for (const { stationId, siteId } of stations) {
    const shift = shiftByStation.get(stationId);
    if (!shift) continue;
    const agg = aggsByShift.get(shift.shiftInstanceId)?.get(stationId);
    if (!agg) continue;

    try {
      const snapshot = aggregateToSnapshot(agg, shift);
      const serialized = `${shift.shiftInstanceId}|${shift.startTime.getTime()}|${JSON.stringify(snapshot)}`;
      if (lastPublished.get(stationId) === serialized) continue;

      const [entityName, path] = await Promise.all([
        resolveEntityName("STATION", stationId, undefined, ctx),
        resolveEntityPath("STATION", stationId, siteId, undefined, ctx),
      ]);

      const change: BucketChange = {
        siteId,
        entityType: "STATION",
        entityId: stationId,
        jobId: null,
        entityName,
        path,
        granularity: "SHIFT",
        granularityName: shift.shiftName,
        startTime: shift.startTime,
        // Sum of contributing hour rows — matches the legacy persisted
        // SHIFT row, whose durationSeconds was re-summed from hours.
        durationSeconds: agg.durationSeconds,
        shiftInstanceId: shift.shiftInstanceId,
        businessDate: shift.businessDate,
        businessShift: shift.shiftName,
        snapshot,
      };
      publishMetricChange(change);
      lastPublished.set(stationId, serialized);
    } catch (err) {
      console.error(`[shift-publisher] Publish failed for station ${stationId}:`, err);
    }
  }
}

// ── Publish interval (worker process) ────────────────────────────
// Formerly phase 3 of batcher.ts's combined tick; phases 1–2 (discovery
// + base writer) are gone — writes are transition-driven and the hour
// close finalizes rows (see the INVARIANT block above).

/** Interval for the publish tick (ms). Default 5s; raise (via the
 *  SHIFT_PUBLISH_INTERVAL_MS or legacy COMBINED_TICK_MS env var / Fly
 *  secret on the workers app) to cut publish bandwidth, since each tick
 *  re-publishes a full snapshot per changed station. */
const PUBLISH_INTERVAL_MS =
  Number.parseInt(process.env.SHIFT_PUBLISH_INTERVAL_MS ?? "", 10) ||
  Number.parseInt(process.env.COMBINED_TICK_MS ?? "", 10) ||
  5_000;

/** Interval (ms) at which the observer checks whether the current tick
 *  has been running too long. Logs only — no force-reset. */
const TICK_OBSERVER_INTERVAL_MS = 10_000;

/** Threshold (ms) above which the observer logs that a tick is taking
 *  too long. Healthy ticks are well under a second; 30s is far below the
 *  client- and server-side timeouts that would close the connection. */
const TICK_LONG_THRESHOLD_MS = 30_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let observerTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
/** Wall-clock ms when the current tick started; null when idle. */
let tickStartedAt: number | null = null;

async function publishTick(): Promise<void> {
  if (tickRunning) {
    const ageMs = tickStartedAt !== null ? Date.now() - tickStartedAt : 0;
    console.log(`[shift-publisher] tick skipped (previous still running, ${ageMs}ms)`);
    return;
  }
  tickRunning = true;
  tickStartedAt = Date.now();

  try {
    const now = new Date();
    const stations = await discoverActiveStations();
    if (stations.length > 0) {
      await publishShiftAggregates(stations, now);
      const elapsed = Date.now() - tickStartedAt;
      if (elapsed > 3000) {
        console.log(`[shift-publisher] ${stations.length} stations published in ${elapsed}ms`);
      }
    }
  } catch (err) {
    const kind = classifyDbTimeout(err);
    if (kind) console.error(`[shift-publisher] DB timeout fired (${kind}); tick will retry on next interval`);
    console.error("[shift-publisher] Publish tick failed:", err);
  } finally {
    tickRunning = false;
    tickStartedAt = null;
  }
}

/**
 * Start the shift-publisher interval. Call from the rollups worker only.
 */
export function startShiftPublisher(): void {
  if (tickTimer) return;

  tickTimer = setInterval(() => {
    publishTick().catch((err) => {
      console.error("[shift-publisher] Tick failed:", err);
    });
  }, PUBLISH_INTERVAL_MS);

  // Observer: log (only) when the current tick has been running
  // unusually long. Does NOT reset tickRunning — the DB-side and
  // pg-client-side timeouts own the closing; this just makes a wedge
  // visible in logs while it's happening.
  observerTimer = setInterval(() => {
    if (tickStartedAt !== null) {
      const ageMs = Date.now() - tickStartedAt;
      if (ageMs > TICK_LONG_THRESHOLD_MS) {
        console.warn(
          `[shift-publisher] tick still running after ${ageMs}ms (started ${new Date(tickStartedAt).toISOString()})`,
        );
      }
    }
  }, TICK_OBSERVER_INTERVAL_MS);

  console.log(`[shift-publisher] Publish tick started: every ${PUBLISH_INTERVAL_MS / 1000}s`);
}

/**
 * Stop the shift-publisher interval. Call during worker shutdown.
 */
export async function stopShiftPublisher(): Promise<void> {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (observerTimer) {
    clearInterval(observerTimer);
    observerTimer = null;
  }
}
