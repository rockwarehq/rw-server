// NATS subject + payload contract for gateway health telemetry.
//
//   health.gateway.<gatewayId>   periodic health snapshot (gw -> cloud) — core, best-effort
//
// This MIRRORS the gateway's rw-gateway/src/subjects.ts (buildGatewayHealthSubject)
// and its GatewayHealthPayload (rw-gateway/src/health/gateway-health.ts). The
// gateway already publishes this every ~5s over the same leaf it uses for tags.>;
// the cloud `gateway-health` worker subscribes to health.gateway.* and mirrors
// each snapshot into prom-client gauges scraped by Fly's managed Prometheus.
//
// Health is ephemeral, latest-wins telemetry, so it rides core NATS (not
// JetStream): a missed report just means one stale scrape, superseded by the
// next. Do NOT change these strings without changing the gateway in lockstep.

// health.gateway.<id> is 3 tokens; health.device.<id>.<ds> (4 tokens) is a
// separate stream and deliberately does not match this filter.
export const GATEWAY_HEALTH_SUBJECT_FILTER = "health.gateway.*";

// Mirrors the gateway's sanitizeToken / graph-subjects.sanitizeSubjectToken.
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
  return `health.gateway.${token}`;
}

// Pulls the gatewayId token back out of a health.gateway.<gatewayId> subject.
// Returns null for anything that isn't the 3-token gateway-health shape (e.g.
// the 4-token health.device.* subject).
export function parseGatewayHealthSubject(subject: string): string | null {
  const parts = subject.split(".");
  if (parts.length !== 3 || parts[0] !== "health" || parts[1] !== "gateway") return null;
  return parts[2] || null;
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
