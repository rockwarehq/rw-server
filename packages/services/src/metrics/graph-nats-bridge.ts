import { connect } from "@nats-io/transport-node";
import { deriveMetricSubject } from "@rw/runtime/graph-subjects";

import { setGraphMetricSink, type MetricChangeEvent } from "../rpc/metrics-bus.js";

// Dual-publishes the worker's bucket metrics to the livestore graph over NATS.
// Registered as a transport-independent sink on the metric bus, so every change
// fans out to NATS alongside the existing Redis path — and keeps working when the
// Redis path is removed. Only STATION SHIFT leaves are bridged; the graph rolls up
// workcenter/site itself.

type Quality = "good" | "stale" | "uncertain" | "bad";
interface ValueEnvelope {
  value: unknown;
  quality: Quality;
  timestamp: number;
}

// Station metrics the graph mirrors as leaves (the additive SHIFT counters). Each
// must be a BucketSnapshot field; the list mirrors livestore node-sync's
// COUNTER_KEYS. Ratios (oee/availability/…) are NOT bridged — the graph derives
// them via expr from these summed components.
const MIRRORED_METRIC_KEYS = [
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
];
const MIRRORED_GRANULARITY = "SHIFT";

// Pure: expand a bucket change into the graph publishes it should produce — one
// per mirrored metric key, read straight off the change snapshot. Empty unless
// it's a STATION SHIFT change. observedAtMs is the commit timestamp.
export function metricChangeToGraphPublishes(
  change: MetricChangeEvent,
  observedAtMs: number,
): { subject: string; envelope: ValueEnvelope }[] {
  if (change.entityType !== "STATION") return [];
  if (change.granularity !== MIRRORED_GRANULARITY) return [];

  const snapshot = change.snapshot as unknown as Record<string, number | string | boolean | null | undefined>;
  return MIRRORED_METRIC_KEYS.map((metricKey) => {
    const value = snapshot[metricKey] ?? null;
    const envelope: ValueEnvelope =
      value == null
        ? { value: null, quality: "stale", timestamp: observedAtMs }
        : { value, quality: "good", timestamp: observedAtMs };
    return { subject: deriveMetricSubject(change.entityId, change.granularity, metricKey), envelope };
  });
}

export interface GraphNatsBridgeOptions {
  natsUrl?: string;
  logger?: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
}

// Start the bridge: connect NATS and register the metric-bus sink. Returns a
// cleanup that unregisters the sink and drains NATS.
//
// NATS_URL is optional for now: with no URL the bridge stays off, and a NATS
// outage at startup disables it rather than crashing the worker. (Make NATS_URL
// required once the graph is load-bearing.)
export async function startGraphNatsBridge(options: GraphNatsBridgeOptions = {}): Promise<() => Promise<void>> {
  const log = options.logger ?? {
    info: (msg: string) => console.log(`[graph-nats-bridge] ${msg}`),
    error: (msg: string, err?: unknown) => console.error(`[graph-nats-bridge] ${msg}`, err),
  };
  const servers = options.natsUrl ?? process.env.NATS_URL;
  if (!servers) {
    log.info("NATS_URL not set — graph bridge disabled");
    return async () => {};
  }

  const nc = await connect({ servers, name: "rw-graph-bridge", maxReconnectAttempts: -1 }).catch(
    (err: unknown) => {
      log.error(`could not connect to NATS at ${servers} — graph bridge disabled`, err);
      return null;
    },
  );
  if (!nc) return async () => {};

  const encoder = new TextEncoder();

  setGraphMetricSink((change) => {
    for (const { subject, envelope } of metricChangeToGraphPublishes(change, Date.now())) {
      nc.publish(subject, encoder.encode(JSON.stringify(envelope)));
    }
  });

  log.info(`dual-publishing STATION SHIFT metrics to NATS at ${nc.getServer()}`);

  return async () => {
    setGraphMetricSink(null);
    await nc.drain();
  };
}
