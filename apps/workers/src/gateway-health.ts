// Consumes gateway health snapshots off NATS and mirrors them into prom-client
// gauges, which main.ts exposes at /metrics for Fly's managed Prometheus to
// scrape (-> Grafana). Replaces the old MQTT -> processor -> Prometheus path.
//
// The gateway publishes a full GatewayHealthPayload to health.gateway.<id> every
// ~5s over its leaf node (see rw-gateway src/health, src/subjects.ts). This is
// ephemeral latest-wins telemetry, so we read core NATS (no JetStream). Needs
// only NATS_URL.

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import client from "prom-client";
import {
  GATEWAY_HEALTH_SUBJECT_FILTER,
  type GatewayHealthPayload,
  parseGatewayHealthSubject,
} from "@rw/runtime/gateway-subjects";

// A gateway is considered up until this long passes with no snapshot. The sweep
// flips gateway_up to 0 so Grafana can gate stale series without us dropping the
// last-known values. Gateway publishes every ~5s, so 90s tolerates ~18 misses.
const STALE_MS = Number.parseInt(process.env.GATEWAY_HEALTH_STALE_MS ?? "", 10) || 90_000;
const SWEEP_MS = 15_000;

const g = (name: string, help: string) => new client.Gauge({ name, help, labelNames: ["gatewayId"] });

// status: up (relay connected) -> 1, else 0; the sweep also drives this to 0.
const up = g("gateway_up", "1 if the gateway is up and reported within the staleness window, else 0");
const memRss = g("gateway_mem_rss_mb", "Gateway resident set size (MB)");
const memHeapUsed = g("gateway_mem_heap_used_mb", "Gateway heap used (MB)");
const memHeapTotal = g("gateway_mem_heap_total_mb", "Gateway heap total (MB)");
const memExternal = g("gateway_mem_external_mb", "Gateway external memory (MB)");
const cpuUser = g("gateway_cpu_user_ms_total", "Cumulative user CPU time (ms) since gateway start");
const cpuSystem = g("gateway_cpu_system_ms_total", "Cumulative system CPU time (ms) since gateway start");
const eventLoopLag = g("gateway_event_loop_lag_ms", "Gateway event loop lag, p99 (ms)");
const uptime = g("gateway_uptime_seconds", "Gateway process uptime (seconds)");
const activeDrivers = g("gateway_active_driver_count", "Number of active drivers on the gateway");
const relayConnected = g("gateway_relay_connected", "1 if the gateway's NATS relay is connected, else 0");
const relayUptime = g("gateway_relay_uptime_seconds", "Seconds since the gateway's relay connected");
const relayReconnects = g("gateway_relay_reconnect_count_total", "Cumulative gateway relay reconnects");
const syncCount = g("gateway_cloud_sync_count_total", "Cumulative cloud /edge/sync attempts");
const syncFailures = g("gateway_cloud_sync_consecutive_failures", "Consecutive cloud sync failures");
const syncLastSuccess = g("gateway_cloud_last_success_timestamp_seconds", "Unix time of last successful cloud sync");
const msgPublished = g("gateway_messages_published_total", "Cumulative NATS messages published by the gateway");
const msgFailures = g("gateway_publish_failures_total", "Cumulative NATS publish failures");
const bytesPublished = g("gateway_bytes_published_total", "Cumulative bytes published by the gateway");
const pointsPublished = g("gateway_points_published_total", "Cumulative tag points published by the gateway");
const lastReport = g("gateway_last_report_timestamp_seconds", "Unix time of the gateway's last health snapshot");
// Metadata carrier: keeps name/version off the numeric series (idiomatic
// Prometheus). Grafana joins the other metrics to this on gatewayId.
const info = new client.Gauge({
  name: "gateway_info",
  help: "Gateway metadata (value is always 1)",
  labelNames: ["gatewayId", "name", "version"],
});

// gatewayId -> last snapshot time (epoch ms), for the staleness sweep.
const lastSeen = new Map<string, number>();

let nc: NatsConnection | null = null;
let sub: Subscription | null = null;
let sweep: ReturnType<typeof setInterval> | null = null;

export async function startGatewayHealth(): Promise<void> {
  nc = await connect({
    servers: natsServers(),
    name: process.env.NATS_CLIENT_NAME || "rw-workers-gateway-health",
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  console.log(`[gateway-health] connected to NATS at ${nc.getServer()}`);

  sub = nc.subscribe(GATEWAY_HEALTH_SUBJECT_FILTER);
  consume(sub);

  sweep = setInterval(sweepStale, SWEEP_MS);
  sweep.unref?.();

  nc.closed().then((err) => {
    if (err) console.error("[gateway-health] NATS connection closed with error", err);
  });
}

export async function stopGatewayHealth(): Promise<void> {
  if (sweep) clearInterval(sweep);
  sweep = null;
  sub?.unsubscribe();
  sub = null;
  if (nc && !nc.isClosed()) await nc.drain();
  nc = null;
}

async function consume(subscription: Subscription): Promise<void> {
  for await (const msg of subscription) {
    const gatewayId = parseGatewayHealthSubject(msg.subject);
    if (!gatewayId) continue; // e.g. health.device.* — not ours
    let payload: GatewayHealthPayload;
    try {
      payload = msg.json<GatewayHealthPayload>();
    } catch (err) {
      console.warn(`[gateway-health] bad JSON on ${msg.subject}: ${String(err)}`);
      continue;
    }
    apply(gatewayId, payload);
  }
}

function apply(gatewayId: string, p: GatewayHealthPayload): void {
  const now = Date.now();
  lastSeen.set(gatewayId, now);

  up.set({ gatewayId }, p.status === "up" ? 1 : 0);
  lastReport.set({ gatewayId }, Math.floor(now / 1000));
  info.set({ gatewayId, name: p.gateway ?? "", version: p.version ?? "" }, 1);

  set(memRss, gatewayId, p.mem?.rssMb);
  set(memHeapUsed, gatewayId, p.mem?.heapUsedMb);
  set(memHeapTotal, gatewayId, p.mem?.heapTotalMb);
  set(memExternal, gatewayId, p.mem?.externalMb);
  set(cpuUser, gatewayId, p.cpu?.userMs);
  set(cpuSystem, gatewayId, p.cpu?.systemMs);
  set(eventLoopLag, gatewayId, p.eventLoopLagMs);
  set(uptime, gatewayId, p.uptimeSec);
  set(activeDrivers, gatewayId, p.activeDriverCount);
  set(relayConnected, gatewayId, p.relay?.connected ? 1 : 0);
  set(relayUptime, gatewayId, p.relay?.uptimeSec);
  set(relayReconnects, gatewayId, p.relay?.reconnectCount);
  set(syncCount, gatewayId, p.cloudSync?.syncCount);
  set(syncFailures, gatewayId, p.cloudSync?.consecutiveFailures);
  if (typeof p.cloudSync?.lastSuccessAt === "number") {
    syncLastSuccess.set({ gatewayId }, Math.floor(p.cloudSync.lastSuccessAt / 1000));
  }
  set(msgPublished, gatewayId, p.messages?.publishedTotal);
  set(msgFailures, gatewayId, p.messages?.publishFailures);
  set(bytesPublished, gatewayId, p.messages?.bytesPublished);
  set(pointsPublished, gatewayId, p.messages?.pointsPublished);
}

function sweepStale(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [gatewayId, seen] of lastSeen) {
    if (seen < cutoff) up.set({ gatewayId }, 0);
  }
}

function set(gauge: client.Gauge<"gatewayId">, gatewayId: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) gauge.set({ gatewayId }, value);
}

function natsServers(): string | string[] {
  const servers = (process.env.NATS_URL ?? "nats://localhost:4222")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length <= 1) return servers[0] ?? "nats://localhost:4222";
  return servers;
}
