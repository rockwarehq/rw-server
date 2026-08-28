import { jetstream, jetstreamManager, DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  deriveCallEventSubject,
  CALL_EVENT_STREAM,
  CALL_EVENT_SUBJECT_FILTER,
  type CallEvent,
} from "@rw/runtime/call-events";
import { call } from "@rw/services/facility/index";
import { moduleLogger } from "../logger.js";
import { ensureStream, natsServers } from "./util.js";

const log = moduleLogger("call-event-publisher");

const encoder = new TextEncoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

export async function startCallEventPublisher(): Promise<() => Promise<void>> {
  const servers = process.env.NATS_URL;
  if (!servers) {
    log.info("NATS_URL not set, call events disabled");
    return async () => {};
  }

  const nc = await connect({
    servers: natsServers(servers),
    name: process.env.NATS_CLIENT_NAME || "rw-api-call-events",
    maxReconnectAttempts: -1,
  }).catch((err: unknown) => {
    log.error({ err }, "could not connect to NATS, call events disabled");
    return null;
  });
  if (!nc) return async () => {};

  const jsm = await jetstreamManager(nc);
  try {
    await ensureCallEventStream(jsm);
  } catch (err) {
    log.error({ err }, "could not ensure JetStream stream, call events disabled");
    await nc.drain();
    return async () => {};
  }
  const js = jetstream(nc);

  call.setCallEventSink(async (event) => {
    const subject = deriveCallEventSubject({ siteId: event.siteId, callId: event.callId, action: event.action });
    await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id }).catch((err: unknown) => {
      log.error({ err, event }, "publish failed");
    });
  });

  log.info({ server: nc.getServer() }, "publishing call events");

  return async () => {
    call.setCallEventSink(null);
    await nc.drain();
  };
}

function ensureCallEventStream(jsm: Awaited<ReturnType<typeof jetstreamManager>>): Promise<void> {
  return ensureStream(jsm, CALL_EVENT_STREAM, CALL_EVENT_SUBJECT_FILTER, {
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_msgs: 100_000,
    max_age: WEEK_NANOS,
    duplicate_window: TWO_MINUTES_NANOS,
  });
}

export type { CallEvent };
