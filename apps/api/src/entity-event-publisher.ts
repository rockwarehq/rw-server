import { jetstream, jetstreamManager, DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  deriveEntityEventSubject,
  ENTITY_EVENT_STREAM,
  ENTITY_EVENT_SUBJECT_FILTER,
  type EntityEvent,
} from "@rw/runtime/entity-events";
import { setEntityEventSink } from "@rw/services/entity/index";

const encoder = new TextEncoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

export async function startEntityEventPublisher(): Promise<() => Promise<void>> {
  const servers = process.env.NATS_URL;
  if (!servers) {
    console.log("[entity-event-publisher] NATS_URL not set, entity events disabled");
    return async () => {};
  }

  const nc = await connect({
    servers: natsServers(servers),
    name: process.env.NATS_CLIENT_NAME || "rw-api-entity-events",
    maxReconnectAttempts: -1,
  }).catch((err: unknown) => {
    console.error("[entity-event-publisher] could not connect to NATS, entity events disabled", err);
    return null;
  });
  if (!nc) return async () => {};

  const jsm = await jetstreamManager(nc);
  try {
    await ensureEntityEventStream(jsm);
  } catch (err) {
    console.error("[entity-event-publisher] could not ensure JetStream stream, entity events disabled", err);
    await nc.drain();
    return async () => {};
  }
  const js = jetstream(nc);

  setEntityEventSink(async (event) => {
    const subject = deriveEntityEventSubject(event);
    await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id }).catch((err: unknown) => {
      console.error("[entity-event-publisher] publish failed", { err, event });
    });
  });

  console.log(`[entity-event-publisher] publishing entity events to ${nc.getServer()}`);

  return async () => {
    setEntityEventSink(null);
    await nc.drain();
  };
}

async function ensureEntityEventStream(jsm: Awaited<ReturnType<typeof jetstreamManager>>): Promise<void> {
  try {
    const info = await jsm.streams.info(ENTITY_EVENT_STREAM);
    const subjects = new Set(info.config.subjects ?? []);
    if (!subjects.has(ENTITY_EVENT_SUBJECT_FILTER)) {
      await jsm.streams.update(ENTITY_EVENT_STREAM, { subjects: [...subjects, ENTITY_EVENT_SUBJECT_FILTER] });
    }
    return;
  } catch {
    await jsm.streams.add({
      name: ENTITY_EVENT_STREAM,
      subjects: [ENTITY_EVENT_SUBJECT_FILTER],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_msgs: 100_000,
      max_age: WEEK_NANOS,
      duplicate_window: TWO_MINUTES_NANOS,
    });
  }
}

function natsServers(value: string): string | string[] {
  const servers = value
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length === 1) return servers[0] as string;
  return servers;
}

export type { EntityEvent };
