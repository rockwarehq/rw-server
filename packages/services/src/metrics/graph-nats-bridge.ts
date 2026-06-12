import { connect } from "@nats-io/transport-node";
import { deriveMetricSubject, MIRRORED_GRANULARITY, MIRRORED_METRIC_KEYS } from "@rw/runtime/graph-subjects";

import { setGraphMetricSink, type MetricChangeEvent } from "../rpc/metrics-bus.js";

// Dual-publishes the metrics to REDIS and NATS

type Quality = "good" | "stale" | "uncertain" | "bad";
interface ValueEnvelope {
  value: unknown;
  quality: Quality;
  timestamp: number;
}

// Metrics changes each own publish to NATS with a subject
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

// Create connection to NATS and publish sink
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

  const nc = await connect({ servers, name: "rw-graph-bridge", maxReconnectAttempts: -1 }).catch((err: unknown) => {
    log.error(`could not connect to NATS at ${servers} — graph bridge disabled`, err);
    return null;
  });
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
