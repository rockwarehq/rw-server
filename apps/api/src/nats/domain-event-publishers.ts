import { jetstream, jetstreamManager } from "@nats-io/jetstream";
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
  deriveJobEventSubject,
  JOB_EVENT_STREAM,
  JOB_EVENT_SUBJECT_FILTER,
  type JobEvent,
} from "@rw/runtime/job-events";
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
import { call, productionMode, station } from "@rw/services/facility/index";
import { setNotificationEventSink } from "@rw/services/notification/index";
import { moduleLogger } from "../logger.js";
import { ensureStream, getNatsConnection } from "./util.js";

// One JetStream publisher per domain event stream (see ADR-0004). Each installs itself as the
// domain's event sink and publishes every event on its derived subject with the event id as
// msgID for dedup. Disabled (no-op cleanup) when the shared NATS connection is unavailable.

const encoder = new TextEncoder();

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
  const nc = await getNatsConnection();
  if (!nc) return async () => {};

  try {
    await ensureStream(await jetstreamManager(nc), p.stream, p.filter);
  } catch (err) {
    log.error({ err }, `could not ensure JetStream stream, ${p.name} disabled`);
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

  log.info(`publishing ${p.name}`);

  return async () => p.setSink(null);
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

export const startJobEventPublisher = () =>
  startDomainEventPublisher<JobEvent>({
    name: "job-events",
    stream: JOB_EVENT_STREAM,
    filter: JOB_EVENT_SUBJECT_FILTER,
    subjectFor: (e) => deriveJobEventSubject({ siteId: e.siteId, stationId: e.stationId, action: e.action }),
    setSink: station.setJobEventSink,
  });
