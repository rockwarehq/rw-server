import { EventPublisher } from "@orpc/server";
import { METRIC_CATALOG_REGISTRY } from "../metric-catalog/index.js";
import type { BucketChange } from "../metrics/sync.js";

export type MetricChangeEvent = BucketChange;

export type MetricValuePrimitive = number | string | boolean | null;

export interface MetricValueEvent {
  siteId: string;
  entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB";
  /** For JOB buckets this is the station id (see jobId). */
  entityId: string;
  /** Job id for JOB-entity bucket events, null/undefined otherwise. */
  jobId?: string | null;
  metricKey: string;
  args?: Record<string, unknown>;
  sourceType: "bucket" | "live";
  value: MetricValuePrimitive;
  observedAt: Date;
  entityName: string;
  path: string;
  granularity?: "MINUTE" | "HOUR" | "SHIFT" | "DAY";
  granularityName?: string;
  startTime?: Date;
  durationSeconds?: number;
  shiftInstanceId?: string | null;
  businessDate?: Date | null;
  businessShift?: string | null;
}

interface MetricEventMap {
  change: MetricChangeEvent;
  value: MetricValueEvent;
}

const metricsPublisher = new EventPublisher<MetricEventMap>({
  maxBufferedEvents: 500,
});

const BUCKET_VALUE_KEYS = METRIC_CATALOG_REGISTRY.filter(
  (definition) => !definition.granularities.some((granularity) => granularity === "LIVE"),
).map((definition) => definition.key);

// In-process listener bus only. The Redis cross-process bridge (ADR-0008's
// SSE metric streams) is gone — the sole cross-process consumer left is the
// graph NATS sink below, which the rollups worker wires via
// setGraphMetricSink (graph-nats-bridge.ts).

// Transport-independent graph sink: called for every change in addition to
// the local bus. Lets the livestore NATS bridge publish at the source.
let graphMetricSink: ((change: MetricChangeEvent) => void) | null = null;
export function setGraphMetricSink(sink: ((change: MetricChangeEvent) => void) | null): void {
  graphMetricSink = sink;
}

export function publishMetricChange(change: MetricChangeEvent): void {
  metricsPublisher.publish("change", change);
  emitLocalBucketValues(change);
  if (graphMetricSink) {
    try {
      graphMetricSink(change);
    } catch (err) {
      // The graph sink must never break the metric pipeline.
      console.error("[metrics-bus] graph sink failed:", err);
    }
  }
}

export function subscribeMetricChanges(options?: { signal?: AbortSignal }) {
  return metricsPublisher.subscribe("change", options);
}

export function publishMetricValueChange(change: MetricValueEvent): void {
  metricsPublisher.publish("value", change);
}

// Derive the per-metric bucket value events from a single bucket change. Pure —
// every field comes from the change/snapshot, so this can run anywhere the
// change is available.
function buildBucketValueEvents(change: MetricChangeEvent): MetricValueEvent[] {
  const snapshot = change.snapshot as unknown as Record<string, MetricValuePrimitive>;
  const observedAt = new Date();

  return BUCKET_VALUE_KEYS.map((metricKey) => ({
    siteId: change.siteId,
    entityType: change.entityType,
    entityId: change.entityId,
    jobId: change.jobId ?? null,
    metricKey,
    args: { granularity: change.granularity },
    sourceType: "bucket",
    value: snapshot[metricKey] ?? null,
    observedAt,
    entityName: change.entityName,
    path: change.path,
    granularity: change.granularity,
    granularityName: change.granularityName,
    startTime: change.startTime,
    durationSeconds: change.durationSeconds,
    shiftInstanceId: change.shiftInstanceId,
    businessDate: change.businessDate,
    businessShift: change.businessShift,
  }));
}

// Expand a bucket change into value events on the local in-process bus.
function emitLocalBucketValues(change: MetricChangeEvent): void {
  for (const value of buildBucketValueEvents(change)) {
    metricsPublisher.publish("value", value);
  }
}

export function subscribeMetricValueChanges(options?: { signal?: AbortSignal }) {
  return metricsPublisher.subscribe("value", options);
}
