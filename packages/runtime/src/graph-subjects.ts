// The only granularity bridged end-to-end right now.
export const MIRRORED_GRANULARITY = "SHIFT";

// The MetricBucket columns the bridge publishes 
export const MIRRORED_METRIC_KEYS = [
  "totalCycles",
  "goodCycles",
  "badCycles",
  "expectedCycles",
  "totalItems",
  "goodItems",
  "badItems",
  "expectedItems",
  "runSeconds",
  "downSeconds",
  "plannedDownSeconds",
  "unplannedDownSeconds",
  "plannedProductionSeconds",
  "idealCycleSeconds",
  "totalCycleSeconds",
  "elapsedExpectedCycles",
  "elapsedExpectedItems",
  "elapsedPlannedProductionSeconds",
] as const;

export type MirroredMetricKey = (typeof MIRRORED_METRIC_KEYS)[number];

function sanitizeSubjectToken(value: string): string {
  const token = value.trim().replaceAll("/", ".").replaceAll("\\", ".").replace(/\s+/g, "_");
  return token
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/[*>]/g, "_"))
    .join(".");
}


export function deriveTagSubject(deviceId: string, tagPath: string): string {
  const deviceToken = sanitizeSubjectToken(deviceId);
  const pathToken = sanitizeSubjectToken(tagPath);
  if (!deviceToken) throw new Error("deviceId must produce a non-empty NATS subject token");
  if (!pathToken) throw new Error("tagPath must produce a non-empty NATS subject token");
  return `tags.${deviceToken}.${pathToken}`;
}

// Worker-computed metric subject
export function deriveMetricSubject(entityId: string, granularity: string, metricKey: string): string {
  const e = sanitizeSubjectToken(entityId);
  const g = sanitizeSubjectToken(granularity);
  const m = sanitizeSubjectToken(metricKey);
  if (!e || !g || !m) throw new Error("metric subject requires entityId, granularity, metricKey");
  return `metrics.${e}.${g}.${m}`;
}
