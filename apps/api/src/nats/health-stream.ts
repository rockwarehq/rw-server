import { DeliverPolicy, jetstream, jetstreamManager, StorageType } from "@nats-io/jetstream";
import {
  type DeviceHealthPayload,
  deriveDeviceHealthSubjectFilter,
  deriveGatewayHealthSubject,
  type GatewayHealthPayload,
  HEALTH_STREAM,
  HEALTH_STREAM_SUBJECTS,
  parseDeviceHealthSubject,
  parseGatewayHealthSubject,
} from "@rw/runtime/gateway-subjects";
import { moduleLogger } from "../logger.js";
import { ensureStream, getNatsConnection } from "./util.js";

const log = moduleLogger("health-stream");

const decoder = new TextDecoder();
const MINUTE_NANOS = 60 * 1_000_000_000;

// Gateways publish health on core NATS (gateway every ~5s, each driver every
// ~10s and on connect/disconnect). RW_HEALTH keeps only the latest snapshot per
// subject, in memory, so a viewer gets current state the moment it opens
// instead of waiting for the next report. Snapshots age out after 15 minutes:
// a gateway gone that long shows no data rather than a frozen last state.
// Nothing here touches the database.
const HEALTH_MAX_AGE_NANOS = 15 * MINUTE_NANOS;
const HEALTH_MAX_BYTES = 32 * 1024 * 1024;

export type GatewayHealthEvent =
  | { kind: "gateway"; ageMs: number; snapshot: GatewayHealthPayload }
  | { kind: "device"; datasourceId: string; ageMs: number; snapshot: DeviceHealthPayload };

let streamReady = false;

export async function startHealthStream(): Promise<() => Promise<void>> {
  const nc = await getNatsConnection();
  if (!nc) return async () => {};

  try {
    await ensureStream(await jetstreamManager(nc), HEALTH_STREAM, HEALTH_STREAM_SUBJECTS, {
      storage: StorageType.Memory,
      max_msgs_per_subject: 1,
      max_age: HEALTH_MAX_AGE_NANOS,
      max_bytes: HEALTH_MAX_BYTES,
    });
  } catch (err) {
    log.error({ err }, "could not ensure JetStream stream, gateway health streaming disabled");
    return async () => {};
  }
  streamReady = true;
  log.info("keeping latest gateway + device health");

  return async () => {
    streamReady = false;
  };
}

/**
 * One gateway's health: the latest stored snapshot for the gateway and each of
 * its drivers, then every new snapshot as it arrives, until `signal` aborts.
 * Null when NATS or the stream is unavailable.
 */
export async function watchGatewayHealth(
  gatewayId: string,
  signal?: AbortSignal,
): Promise<AsyncGenerator<GatewayHealthEvent> | null> {
  const nc = await getNatsConnection();
  if (!nc || !streamReady) return null;

  // An ordered consumer delivering last-per-subject replays the stored state,
  // then keeps delivering live; it is ephemeral and goes away with the viewer.
  const consumer = await jetstream(nc).consumers.get(HEALTH_STREAM, {
    filter_subjects: [deriveGatewayHealthSubject(gatewayId), deriveDeviceHealthSubjectFilter(gatewayId)],
    deliver_policy: DeliverPolicy.LastPerSubject,
  });
  const messages = await consumer.consume();

  return (async function* () {
    // The iterator is parked awaiting the next message, so a client disconnect
    // has to stop it from outside; that ends the loop below.
    const onAbort = () => void messages.stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const message of messages) {
        const event = toHealthEvent(message.subject, message.data, message.time.getTime(), Date.now());
        if (event) yield event;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      void messages.stop();
      // The server would otherwise keep it for the client's 5-minute default.
      consumer.delete().catch(() => {});
    }
  })();
}

/**
 * A stored health message as a client event. `ageMs` is measured on the server
 * so a client with a skewed clock still judges staleness correctly.
 */
export function toHealthEvent(
  subject: string,
  data: Uint8Array,
  receivedAt: number,
  now: number,
): GatewayHealthEvent | null {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(decoder.decode(data));
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== "object") return null;
  const ageMs = Math.max(0, now - receivedAt);

  if (parseGatewayHealthSubject(subject)) {
    return { kind: "gateway", ageMs, snapshot: snapshot as GatewayHealthPayload };
  }
  const device = parseDeviceHealthSubject(subject);
  if (device) {
    return { kind: "device", datasourceId: device.datasourceId, ageMs, snapshot: snapshot as DeviceHealthPayload };
  }
  return null;
}
