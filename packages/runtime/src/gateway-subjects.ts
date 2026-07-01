// NATS subject + payload conventions for gateway health telemetry.
//
//   gateway.health.<gatewayId>   periodic health/metrics report (gw -> cloud) — core, best-effort
//
// Health is ephemeral, latest-wins telemetry, so it rides core NATS (not
// JetStream): a missed report just means one stale scrape, and the next report
// (every ~30s) supersedes it. The gateway publishes over the same leaf node it
// already uses for tags.>. The cloud `gateway-health` worker subscribes to
// gateway.health.* and mirrors each report into prom-client gauges scraped by
// Fly's managed Prometheus at /metrics.
//
// The gateway mirrors these exact strings in rw-gateway/src/subjects.ts.

export const GATEWAY_HEALTH_SUBJECT_FILTER = "gateway.health.*";

// Mirrors graph-subjects.sanitizeSubjectToken and the gateway's sanitizeToken.
function sanitizeSubjectToken(value: string): string {
  const token = value.trim().replaceAll("/", ".").replaceAll("\\", ".").replace(/\s+/g, "_");
  return token
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/[*>]/g, "_"))
    .join(".");
}

export function deriveGatewayHealthSubject(gatewayId: string): string {
  const token = sanitizeSubjectToken(gatewayId);
  if (!token) throw new Error("gatewayId must produce a non-empty NATS subject token");
  return `gateway.health.${token}`;
}

// Pulls the gatewayId token back out of a gateway.health.<gatewayId> subject.
// Returns null for anything that doesn't match the 3-token shape.
export function parseGatewayHealthSubject(subject: string): string | null {
  const parts = subject.split(".");
  if (parts.length !== 3 || parts[0] !== "gateway" || parts[1] !== "health") return null;
  return parts[2] || null;
}

// Resource snapshot — mirrors the Gateway.health JSON column.
export interface GatewayHealth {
  cpu?: number; // cpu load, percent (0-100)
  memoryPct?: number; // memory used, percent (0-100)
  diskPct?: number; // disk used, percent (0-100)
  uptime?: number; // process uptime, seconds
}

// Throughput snapshot — mirrors the Gateway.metrics JSON column.
export interface GatewayMetrics {
  pointsPerSec?: number;
  messagesPerMin?: number;
  errorCount?: number;
}

// gw -> cloud health report published core on gateway.health.<gatewayId>.
// gatewayId is authoritative from the subject; the optional field is for
// convenience/debugging. siteId/name are labels the gateway may not know.
export interface GatewayHealthReport {
  gatewayId?: string;
  name?: string;
  siteId?: string;
  version?: string;
  health?: GatewayHealth;
  metrics?: GatewayMetrics;
  ts?: number; // gateway-side emit time (epoch ms)
}
