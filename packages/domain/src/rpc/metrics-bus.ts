import { EventPublisher } from "@orpc/server";
import { METRIC_CATALOG_REGISTRY } from "../services/metric-catalog/index.js";
import type { BucketChange } from "../services/metrics/sync.js";

export type MetricChangeEvent = BucketChange;

export type MetricValuePrimitive = number | string | boolean | null;

export interface MetricValueEvent {
  siteId: string;
  entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB";
  entityId: string;
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

export function publishMetricChange(change: MetricChangeEvent): void {
  metricsPublisher.publish("change", change);
}

export function subscribeMetricChanges(options?: { signal?: AbortSignal }) {
  return metricsPublisher.subscribe("change", options);
}

export function publishMetricValueChange(change: MetricValueEvent): void {
  metricsPublisher.publish("value", change);
}

export function publishBucketMetricValueChanges(change: MetricChangeEvent): void {
  const snapshot = change.snapshot as unknown as Record<string, MetricValuePrimitive>;
  const observedAt = new Date();

  for (const metricKey of BUCKET_VALUE_KEYS) {
    publishMetricValueChange({
      siteId: change.siteId,
      entityType: change.entityType,
      entityId: change.entityId,
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
    });
  }
}

export function subscribeMetricValueChanges(options?: { signal?: AbortSignal }) {
  return metricsPublisher.subscribe("value", options);
}
