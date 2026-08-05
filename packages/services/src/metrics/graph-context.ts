import { connect, type NatsConnection } from "@nats-io/transport-node";
import { deriveMetricSubject, MIRRORED_GRANULARITY, type MirroredContextKey } from "@rw/runtime/graph-subjects";

/**
 * Instant publisher for STATION SHIFT context envelopes (currentJobName,
 * currentStandardCycle, ...) on the same subjects the graph NATS bridge
 * mirrors bucket snapshots to.
 *
 * The bridge only fires on bucket *changes*, which are driven by rollup
 * ticks — a job change would otherwise not reach livestore until the shift
 * bucket next re-emits (and, before the row is re-stamped, would re-emit the
 * OLD value). Callers must therefore stamp the current bucket row AND publish
 * here, so the live value and the next tick agree.
 *
 * The bridge lives in the rollups worker; job changes run in the api — hence
 * a separate lazy connection rather than reusing the bridge's sink.
 */

type Quality = "good" | "stale" | "uncertain" | "bad";
interface ValueEnvelope {
  value: unknown;
  quality: Quality;
  timestamp: number;
}

let nc: NatsConnection | null = null;
let connecting: Promise<NatsConnection | null> | null = null;

async function connection(): Promise<NatsConnection | null> {
  if (nc && !nc.isClosed()) return nc;
  if (!connecting) {
    const servers = process.env.NATS_URL;
    connecting = servers
      ? connect({ servers, name: "rw-graph-context", maxReconnectAttempts: -1 })
          .then((conn) => (nc = conn))
          .catch((err: unknown) => {
            console.error("[graph-context] could not connect to NATS — instant context publish disabled", err);
            return null;
          })
          .finally(() => {
            connecting = null;
          })
      : Promise.resolve(null);
  }
  return connecting;
}

const encoder = new TextEncoder();

/** Publish context values for a station's SHIFT node fields immediately. */
export async function publishStationShiftContext(
  stationId: string,
  values: Partial<Record<MirroredContextKey, unknown>>,
): Promise<void> {
  const conn = await connection();
  if (!conn) return;
  const timestamp = Date.now();
  for (const [key, value] of Object.entries(values)) {
    const envelope: ValueEnvelope =
      value == null ? { value: null, quality: "stale", timestamp } : { value, quality: "good", timestamp };
    conn.publish(deriveMetricSubject(stationId, MIRRORED_GRANULARITY, key), encoder.encode(JSON.stringify(envelope)));
  }
}
