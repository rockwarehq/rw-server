import { jetstream, jetstreamManager, DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  CALL_EVENT_STREAM,
  CALL_EVENT_SUBJECT_FILTER,
  type CallEvent,
  deriveCallEventSubject,
} from "@rw/runtime/call-events";
import {
  deriveEntityEventSubject,
  ENTITY_EVENT_STREAM,
  ENTITY_EVENT_SUBJECT_FILTER,
  type EntityEvent,
} from "@rw/runtime/entity-events";
import {
  deriveModeEventSubject,
  MODE_EVENT_STREAM,
  MODE_EVENT_SUBJECT_FILTER,
  type ModeEvent,
} from "@rw/runtime/mode-events";
import {
  deriveNotificationEventSubject,
  NOTIFICATION_EVENT_STREAM,
  NOTIFICATION_EVENT_SUBJECT_FILTER,
  type NotificationEvent,
} from "@rw/runtime/notification-events";
import { setEntityEventSink } from "@rw/services/entity/index";
import { call, productionMode } from "@rw/services/facility/index";
import { setNotificationEventSink } from "@rw/services/notification/index";
import { moduleLogger } from "../logger.js";
import { ensureStream, natsServers } from "./util.js";

// One JetStream publisher per domain event stream (see ADR-0004). Each installs itself as the
// domain's event sink and publishes every event on its derived subject with the event id as
// msgID for dedup. Disabled (no-op cleanup) when NATS_URL is unset or the connection fails.

const encoder = new TextEncoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

interface DomainPublisher<T extends { id: string }> {
  name: string;
  stream: string;
  filter: string;
  subjectFor(event: T): string;
  setSink(sink: ((event: T) => Promise<void>) | null): void;
}

async function startDomainEventPublisher<T extends { id: string }>(
  p: DomainPublisher<T>,
): Promise<() => Promise<void>> {
  const log = moduleLogger(`${p.name}-publisher`);
  const servers = process.env.NATS_URL;
  if (!servers) {
    log.info(`NATS_URL not set, ${p.name} disabled`);
    return async () => {};
  }

  const nc = await connect({
    servers: natsServers(servers),
    name: process.env.NATS_CLIENT_NAME || `rw-api-${p.name}`,
    maxReconnectAttempts: -1,
  }).catch((err: unknown) => {
    log.error({ err }, `could not connect to NATS, ${p.name} disabled`);
    return null;
  });
  if (!nc) return async () => {};

  const jsm = await jetstreamManager(nc);
  try {
    await ensureStream(jsm, p.stream, p.filter, {
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_msgs: 100_000,
      max_age: WEEK_NANOS,
      duplicate_window: TWO_MINUTES_NANOS,
    });
  } catch (err) {
    log.error({ err }, `could not ensure JetStream stream, ${p.name} disabled`);
    await nc.drain();
    return async () => {};
  }
  const js = jetstream(nc);

  p.setSink(async (event) => {
    await js
      .publish(p.subjectFor(event), encoder.encode(JSON.stringify(event)), { msgID: event.id })
      .catch((err: unknown) => {
        log.error({ err, event }, "publish failed");
      });
  });

  log.info({ server: nc.getServer() }, `publishing ${p.name}`);

  return async () => {
    p.setSink(null);
    await nc.drain();
  };
}

export const startEntityEventPublisher = () =>
  startDomainEventPublisher<EntityEvent>({
    name: "entity-events",
    stream: ENTITY_EVENT_STREAM,
    filter: ENTITY_EVENT_SUBJECT_FILTER,
    subjectFor: deriveEntityEventSubject,
    setSink: setEntityEventSink,
  });

export const startCallEventPublisher = () =>
  startDomainEventPublisher<CallEvent>({
    name: "call-events",
    stream: CALL_EVENT_STREAM,
    filter: CALL_EVENT_SUBJECT_FILTER,
    subjectFor: (e) => deriveCallEventSubject({ siteId: e.siteId, callId: e.callId, action: e.action }),
    setSink: call.setCallEventSink,
  });

export const startModeEventPublisher = () =>
  startDomainEventPublisher<ModeEvent>({
    name: "mode-events",
    stream: MODE_EVENT_STREAM,
    filter: MODE_EVENT_SUBJECT_FILTER,
    subjectFor: (e) => deriveModeEventSubject({ siteId: e.siteId, stationId: e.stationId, action: e.action }),
    setSink: productionMode.setModeEventSink,
  });

export const startNotificationEventPublisher = () =>
  startDomainEventPublisher<NotificationEvent>({
    name: "notification-events",
    stream: NOTIFICATION_EVENT_STREAM,
    filter: NOTIFICATION_EVENT_SUBJECT_FILTER,
    subjectFor: (e) =>
      deriveNotificationEventSubject({ siteId: e.siteId, notificationId: e.notificationId, action: e.action }),
    setSink: setNotificationEventSink,
  });
