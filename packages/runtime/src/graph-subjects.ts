// NATS subject conventions shared between the metric producer (the rollups worker
// bridge) and the consumer (livestore's resolvers). Both ends MUST derive subjects
// with the same function, or published messages won't reach the subscribed
// properties — so this lives in a shared package, not in either app.

function sanitizeSubjectToken(value: string): string {
  const token = value.trim().replaceAll("/", ".").replaceAll("\\", ".").replace(/\s+/g, "_");
  return token
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/[*>]/g, "_"))
    .join(".");
}

// Raw signal (PLC) subject: tags.<deviceId>.<tagPath>
export function deriveTagSubject(deviceId: string, tagPath: string): string {
  const deviceToken = sanitizeSubjectToken(deviceId);
  const pathToken = sanitizeSubjectToken(tagPath);
  if (!deviceToken) throw new Error("deviceId must produce a non-empty NATS subject token");
  if (!pathToken) throw new Error("tagPath must produce a non-empty NATS subject token");
  return `tags.${deviceToken}.${pathToken}`;
}

// Worker-computed metric subject: metrics.<entityId>.<granularity>.<metricKey>
export function deriveMetricSubject(entityId: string, granularity: string, metricKey: string): string {
  const e = sanitizeSubjectToken(entityId);
  const g = sanitizeSubjectToken(granularity);
  const m = sanitizeSubjectToken(metricKey);
  if (!e || !g || !m) throw new Error("metric subject requires entityId, granularity, metricKey");
  return `metrics.${e}.${g}.${m}`;
}
