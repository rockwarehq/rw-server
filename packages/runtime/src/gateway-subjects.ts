// NATS subject + payload contract for gateway health telemetry.
//
//   health.gateway.<gatewayId>                 periodic health snapshot (gw -> cloud) — core, best-effort
//   health.device.<gatewayId>.<datasourceId>   per-driver health snapshot (gw -> cloud) — core, best-effort
//
// This MIRRORS the gateway's rw-gateway/src/subjects.ts (buildGatewayHealthSubject)
// and its GatewayHealthPayload (rw-gateway/src/health/gateway-health.ts). The
// gateway already publishes this every ~5s over the same leaf it uses for tags.>;
// the cloud `gateway-health` worker subscribes to health.gateway.* and mirrors
// each snapshot into prom-client gauges scraped by Fly's managed Prometheus.
//
// Health is ephemeral, latest-wins telemetry, so the gateway publishes it on core
// NATS: a missed report just means one stale scrape, superseded by the next. In
// the cloud the RW_HEALTH stream keeps only the latest snapshot per subject, so
// a viewer that opens mid-stream sees current state at once (api nats/health-
// stream.ts). Do NOT change these strings without changing the gateway in lockstep.

// health.gateway.<id> is 3 tokens; health.device.<id>.<ds> (4 tokens) is a
// separate stream and deliberately does not match this filter.
import { sanitizeSubjectToken } from "./domain-events.js";

export const GATEWAY_HEALTH_SUBJECT_FILTER = "health.gateway.*";

// Latest-per-subject store for both gateway and device health.
export const HEALTH_STREAM = "RW_HEALTH";
export const HEALTH_STREAM_SUBJECTS = "health.>";

// Mirrors the gateway's sanitizeToken / graph-subjects.sanitizeSubjectToken.

export function deriveGatewayHealthSubject(gatewayId: string): string {
  const token = sanitizeSubjectToken(gatewayId);
  if (!token) throw new Error("gatewayId must produce a non-empty NATS subject token");
  return `health.gateway.${token}`;
}

// Every driver's snapshot on one gateway: health.device.<gatewayId>.*
export function deriveDeviceHealthSubjectFilter(gatewayId: string): string {
  const token = sanitizeSubjectToken(gatewayId);
  if (!token) throw new Error("gatewayId must produce a non-empty NATS subject token");
  return `health.device.${token}.*`;
}

// Pulls the gatewayId token back out of a health.gateway.<gatewayId> subject.
// Returns null for anything that isn't the 3-token gateway-health shape (e.g.
// the 4-token health.device.* subject).
export function parseGatewayHealthSubject(subject: string): string | null {
  const parts = subject.split(".");
  if (parts.length !== 3 || parts[0] !== "health" || parts[1] !== "gateway") return null;
  return parts[2] || null;
}

// Pulls { gatewayId, datasourceId } out of a health.device.<gw>.<ds> subject.
// Returns null for anything that isn't the 4-token device-health shape.
export function parseDeviceHealthSubject(subject: string): { gatewayId: string; datasourceId: string } | null {
  const parts = subject.split(".");
  if (parts.length !== 4 || parts[0] !== "health" || parts[1] !== "device") return null;
  if (!parts[2] || !parts[3]) return null;
  return { gatewayId: parts[2], datasourceId: parts[3] };
}

export type GatewayHealthStatus = "up" | "degraded";

// The exact snapshot the gateway publishes. Kept in sync with rw-gateway's
// GatewayHealthPayload — all fields optional here so a schema drift on the
// gateway degrades to missing gauges rather than a hard parse failure.
export interface GatewayHealthPayload {
  status?: GatewayHealthStatus;
  ts?: number; // snapshot time (epoch ms)
  startedAt?: number; // gateway process start (epoch ms)
  gateway?: string; // friendly gateway name/slug (subject token is the id)
  version?: string;
  mem?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
    externalMb?: number;
  };
  cpu?: {
    userMs?: number; // cumulative user CPU (ms) since process start
    systemMs?: number; // cumulative system CPU (ms) since process start
  };
  eventLoopLagMs?: number;
  uptimeSec?: number;
  activeDriverCount?: number;
  relay?: {
    connected?: boolean;
    uptimeSec?: number;
    reconnectCount?: number;
  };
  cloudSync?: {
    lastSuccessAt?: number | null;
    consecutiveFailures?: number;
    syncCount?: number;
  };
  messages?: {
    publishedTotal?: number;
    publishFailures?: number;
    bytesPublished?: number;
    pointsPublished?: number;
  };
}

// One driver's snapshot. Kept in sync with rw-gateway's DriverHealthSnapshot
// (packages/rw-driver-types/src/health.ts); optional for the same reason as above.
// Note totalTags is the size of the last poll batch, not the configured tag count.
export interface DeviceHealthPayload {
  connected?: boolean;
  totalTags?: number;
  badTagCount?: number; // every tag counts as bad while disconnected
  lastPollTimestamp?: number | null; // last data back from the device (epoch ms)
  uptimeMs?: number;
  startedAt?: number; // driver instance start (epoch ms)
  pollCycleTotal?: number;
  pollCycleErrors?: number;
  pollLatencyLastMs?: number;
  pollLatencyAvgMs?: number; // windowed over the snapshot interval
  reconnectCount?: number;
  pointsPolledTotal?: number;
  pointsChangedTotal?: number;
  messagesPublished?: number;
  errorCount?: number;
}
