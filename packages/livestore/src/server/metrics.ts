// Exposes livestore health as Prometheus metrics at /metrics, scraped directly
// by Fly's managed Prometheus (-> Grafana). livestore is a Fly app, reachable on
// the private network, so it needs no push/mirror hop.
//
// Standard process metrics (mem/cpu/event-loop-lag/gc) come from prom-client's
// default collector; the livestore_* gauges below carry engine + hook signals,
// sampled from the runtime at scrape time.

import type { FastifyInstance } from "fastify";
import client from "prom-client";

import type { GraphRuntime } from "../engine/runtime.js";

const register = client.register;
client.collectDefaultMetrics({ register });

const gauge = (name: string, help: string): client.Gauge => new client.Gauge({ name, help, registers: [register] });

const up = gauge("livestore_up", "1 if the graph runtime is ready, else 0");

// Flush health — is the reactive recompute keeping up?
const dirtySetSize = gauge("livestore_dirty_set_size", "Pending recompute backlog; grows if the flush falls behind");
const flushCount = gauge("livestore_flush_count_total", "Cumulative scheduler flushes");
const flushMaxMs = gauge("livestore_flush_max_ms", "Worst flush duration (ms) since the last scrape");
const lastFlush = gauge("livestore_last_flush_timestamp_seconds", "Unix time of the last completed flush");

// Graph size.
const nodeCount = gauge("livestore_graph_node_count", "Graph nodes loaded");
const propertyCount = gauge("livestore_graph_property_count", "Graph properties loaded");
const edgeCount = gauge("livestore_graph_edge_count", "Graph edges loaded");

// Hook health — are matched conditions publishing to JetStream?
const hookMatched = gauge("livestore_hook_matched_total", "Cumulative hook conditions matched + queued");
const hookPublished = gauge("livestore_hook_published_total", "Cumulative hook events published to JetStream");
const hookPublishFailures = gauge("livestore_hook_publish_failures_total", "Cumulative hook event publish failures");
const hookLastPublished = gauge(
  "livestore_hook_last_published_timestamp_seconds",
  "Unix time of the last hook event published",
);
const hookCount = gauge("livestore_hook_count", "Loaded hook definitions");

function setNum(g: client.Gauge, value: number | null | undefined): void {
  if (typeof value === "number" && Number.isFinite(value)) g.set(value);
}

// Epoch-ms field -> Unix-seconds gauge; skips null/undefined.
function setSeconds(g: client.Gauge, epochMs: number | null | undefined): void {
  if (typeof epochMs === "number" && Number.isFinite(epochMs)) g.set(Math.floor(epochMs / 1000));
}

function sample(runtime: GraphRuntime): void {
  const { ready, engine, hooks } = runtime.healthStats();
  up.set(ready ? 1 : 0);

  setNum(dirtySetSize, engine.dirtySetSize);
  setNum(flushCount, engine.flushCount);
  setNum(flushMaxMs, engine.flushMaxMs);
  setSeconds(lastFlush, engine.lastFlushAt);
  setNum(nodeCount, engine.nodeCount);
  setNum(propertyCount, engine.propertyCount);
  setNum(edgeCount, engine.edgeCount);

  setNum(hookMatched, hooks.matchedTotal);
  setNum(hookPublished, hooks.publishedTotal);
  setNum(hookPublishFailures, hooks.publishFailuresTotal);
  setSeconds(hookLastPublished, hooks.lastPublishedAt);
  setNum(hookCount, hooks.hookCount);
}

export function registerMetricsRoute(server: FastifyInstance, runtime: GraphRuntime): void {
  server.get("/metrics", async (_request, reply) => {
    sample(runtime);
    reply.header("Content-Type", register.contentType);
    return await register.metrics();
  });
}
