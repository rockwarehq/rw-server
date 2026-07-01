// Consumes gateway health reports off NATS and mirrors them into prom-client
// gauges, which main.ts exposes at /metrics for Fly's managed Prometheus to
// scrape (-> Grafana). Replaces the old MQTT -> processor -> Prometheus path.
//
// Health is ephemeral, latest-wins telemetry, so this reads core NATS on
// gateway.health.* (no JetStream). Each gateway publishes ~every 30s over the
// leaf node it already uses for tags.>. Needs only NATS_URL.

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import client from "prom-client";
import {
  GATEWAY_HEALTH_SUBJECT_FILTER,
  parseGatewayHealthSubject,
  type GatewayHealthReport,
} from "@rw/runtime/gateway-subjects";

// A gateway is considered up until this long passes with no report. The sweep
// flips gateway_up to 0 so Grafana can gate stale series without us dropping
// the last-known values.
const STALE_MS = Number.parseInt(process.env.GATEWAY_HEALTH_STALE_MS ?? "", 10) || 90_000;
const SWEEP_MS = 15_000;

const up = new client.Gauge({
  name: "gateway_up",
  help: "1 if the gateway reported health within the staleness window, else 0",
  labelNames: ["gatewayId"],
});
const cpu = new client.Gauge({
  name: "gateway_cpu_percent",
  help: "Gateway CPU load (percent, 0-100)",
  labelNames: ["gatewayId"],
});
const memory = new client.Gauge({
  name: "gateway_memory_percent",
  help: "Gateway memory used (percent, 0-100)",
  labelNames: ["gatewayId"],
});
const disk = new client.Gauge({
  name: "gateway_disk_percent",
  help: "Gateway disk used (percent, 0-100)",
  labelNames: ["gatewayId"],
});
const uptime = new client.Gauge({
  name: "gateway_uptime_seconds",
  help: "Gateway process uptime (seconds)",
  labelNames: ["gatewayId"],
});
const pointsPerSec = new client.Gauge({
  name: "gateway_points_per_sec",
  help: "Tag points ingested per second at the gateway",
  labelNames: ["gatewayId"],
});
const messagesPerMin = new client.Gauge({
  name: "gateway_messages_per_min",
  help: "Messages processed per minute at the gateway",
  labelNames: ["gatewayId"],
});
const errorCount = new client.Gauge({
  name: "gateway_error_count",
  help: "Gateway error count in the last report window",
  labelNames: ["gatewayId"],
});
const lastReport = new client.Gauge({
  name: "gateway_last_report_timestamp_seconds",
  help: "Unix timestamp of the gateway's last health report",
  labelNames: ["gatewayId"],
});
// Metadata carrier: keeps name/siteId/version off the numeric series (idiomatic
// Prometheus). Grafana joins the other metrics to this on gatewayId.
const info = new client.Gauge({
  name: "gateway_info",
  help: "Gateway metadata (value is always 1)",
  labelNames: ["gatewayId", "name", "siteId", "version"],
});

// gatewayId -> last report time (epoch ms), for the staleness sweep.
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
    if (!gatewayId) {
      console.warn(`[gateway-health] unexpected subject ${msg.subject}; skipping`);
      continue;
    }
    let report: GatewayHealthReport;
    try {
      report = msg.json<GatewayHealthReport>();
    } catch (err) {
      console.warn(`[gateway-health] bad JSON on ${msg.subject}: ${String(err)}`);
      continue;
    }
    apply(gatewayId, report);
  }
}

function apply(gatewayId: string, report: GatewayHealthReport): void {
  const now = Date.now();
  lastSeen.set(gatewayId, now);

  up.set({ gatewayId }, 1);
  lastReport.set({ gatewayId }, Math.floor(now / 1000));
  info.set({ gatewayId, name: report.name ?? "", siteId: report.siteId ?? "", version: report.version ?? "" }, 1);

  setIfNumber(cpu, gatewayId, report.health?.cpu);
  setIfNumber(memory, gatewayId, report.health?.memoryPct);
  setIfNumber(disk, gatewayId, report.health?.diskPct);
  setIfNumber(uptime, gatewayId, report.health?.uptime);
  setIfNumber(pointsPerSec, gatewayId, report.metrics?.pointsPerSec);
  setIfNumber(messagesPerMin, gatewayId, report.metrics?.messagesPerMin);
  setIfNumber(errorCount, gatewayId, report.metrics?.errorCount);
}

function sweepStale(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [gatewayId, seen] of lastSeen) {
    if (seen < cutoff) up.set({ gatewayId }, 0);
  }
}

function setIfNumber(gauge: client.Gauge<"gatewayId">, gatewayId: string, value: unknown): void {
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
