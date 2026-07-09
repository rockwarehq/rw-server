import { jetstream, jetstreamManager, DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  deriveEntityEventSubject,
  ENTITY_EVENT_STREAM,
  ENTITY_EVENT_SUBJECT_FILTER,
  type EntityEvent,
} from "@rw/runtime/entity-events";
import { setEntityEventSink } from "@rw/services/entity/index";
import { moduleLogger } from "../logger.js";
import { ensureStream, natsServers } from "./util.js";

const log = moduleLogger("entity-event-publisher");

const encoder = new TextEncoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

export async function startEntityEventPublisher(): Promise<() => Promise<void>> {
  const servers = process.env.NATS_URL;
  if (!servers) {
    log.info("NATS_URL not set, entity events disabled");
    return async () => {};
  }

  const nc = await connect({
    servers: natsServers(servers),
    name: process.env.NATS_CLIENT_NAME || "rw-api-entity-events",
    maxReconnectAttempts: -1,
  }).catch((err: unknown) => {
    log.error({ err }, "could not connect to NATS, entity events disabled");
    return null;
  });
  if (!nc) return async () => {};

  const jsm = await jetstreamManager(nc);
  try {
    await ensureEntityEventStream(jsm);
  } catch (err) {
    log.error({ err }, "could not ensure JetStream stream, entity events disabled");
    await nc.drain();
    return async () => {};
  }
  const js = jetstream(nc);

  setEntityEventSink(async (event) => {
    const subject = deriveEntityEventSubject(event);
    await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id }).catch((err: unknown) => {
      log.error({ err, event }, "publish failed");
    });
  });

  log.info({ server: nc.getServer() }, "publishing entity events");

  return async () => {
    setEntityEventSink(null);
    await nc.drain();
  };
}

function ensureEntityEventStream(jsm: Awaited<ReturnType<typeof jetstreamManager>>): Promise<void> {
  return ensureStream(jsm, ENTITY_EVENT_STREAM, ENTITY_EVENT_SUBJECT_FILTER, {
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_msgs: 100_000,
    max_age: WEEK_NANOS,
    duplicate_window: TWO_MINUTES_NANOS,
  });
}

export type { EntityEvent };
