import { AckPolicy, DeliverPolicy, type ConsumerMessages, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { CALL_EVENT_STREAM, CALL_EVENT_SUBJECT_FILTER, parseCallEvent } from "@rw/runtime/call-events";
import type { EventCause } from "@rw/runtime/domain-events";
import { JOB_EVENT_STREAM, JOB_EVENT_SUBJECT_FILTER, parseJobEvent } from "@rw/runtime/job-events";
import { MODE_EVENT_STREAM, MODE_EVENT_SUBJECT_FILTER, parseModeEvent } from "@rw/runtime/mode-events";
import {
  NOTIFICATION_EVENT_STREAM,
  NOTIFICATION_EVENT_SUBJECT_FILTER,
  parseNotificationEvent,
} from "@rw/runtime/notification-events";
import { fromCallEvent } from "../automations/events/call-changed.js";
import { fromJobEvent } from "../automations/events/job-changed.js";
import { fromModeEvent } from "../automations/events/mode-changed.js";
import { fromNotificationEvent } from "../automations/events/notification-changed.js";
import { getAutomationFramework } from "../automations/index.js";
import { moduleLogger } from "../logger.js";
import { natsServers } from "./util.js";

// The bridge from domain event streams into the automation engine: each stream gets a durable
// consumer whose messages are parsed, mapped to an automation event, and fired. Runs in the api
// (same process as the automation store, so edits are seen immediately); with several api
// instances the durable acts as a work queue. Fires reuse the domain event id, so a redelivery
// produces the same automation event id and idempotent actions (notifyGroup) stay single-shot.

const log = moduleLogger("automation-event-consumer");
const decoder = new TextDecoder();
const ACK_WAIT_NANOS = 60 * 1_000_000_000;

interface Bridge {
  stream: string;
  filter: string;
  /** Automation event type fired for this stream. */
  type: string;
  parse(value: unknown): { id: string; cause?: EventCause } | null;
  toPayload(event: never): Record<string, unknown>;
}

const BRIDGES: Bridge[] = [
  {
    stream: CALL_EVENT_STREAM,
    filter: CALL_EVENT_SUBJECT_FILTER,
    type: "call.changed",
    parse: parseCallEvent,
    toPayload: fromCallEvent,
  },
  {
    stream: MODE_EVENT_STREAM,
    filter: MODE_EVENT_SUBJECT_FILTER,
    type: "mode.changed",
    parse: parseModeEvent,
    toPayload: fromModeEvent,
  },
  {
    stream: JOB_EVENT_STREAM,
    filter: JOB_EVENT_SUBJECT_FILTER,
    type: "job.changed",
    parse: parseJobEvent,
    toPayload: fromJobEvent,
  },
  {
    stream: NOTIFICATION_EVENT_STREAM,
    filter: NOTIFICATION_EVENT_SUBJECT_FILTER,
    type: "notification.changed",
    parse: parseNotificationEvent,
    toPayload: fromNotificationEvent,
  },
];

export async function startAutomationEventConsumer(): Promise<() => Promise<void>> {
  const servers = process.env.NATS_URL;
  if (!servers) {
    log.info("NATS_URL not set, automation event consumer disabled");
    return async () => {};
  }

  const nc = await connect({
    servers: natsServers(servers),
    name: process.env.NATS_CLIENT_NAME || "rw-api-automation-events",
    maxReconnectAttempts: -1,
  }).catch((err: unknown) => {
    log.error({ err }, "could not connect to NATS, automation event consumer disabled");
    return null;
  });
  if (!nc) return async () => {};

  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const fw = await getAutomationFramework();
  const running: ConsumerMessages[] = [];

  for (const bridge of BRIDGES) {
    const durable = `rw-api-automations-${bridge.type.replace(".", "-")}`;
    try {
      // The publishers (started before this) ensure the streams exist.
      await jsm.consumers.info(bridge.stream, durable).catch(() =>
        jsm.consumers.add(bridge.stream, {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.New,
          filter_subject: bridge.filter,
          ack_wait: ACK_WAIT_NANOS,
        }),
      );
      const consumer = await js.consumers.get(bridge.stream, durable);
      const messages = await consumer.consume({ max_messages: 50 });
      running.push(messages);
      void loop(messages, bridge);
      log.info({ stream: bridge.stream, durable }, `bridging ${bridge.type}`);
    } catch (err) {
      log.error({ err, stream: bridge.stream }, "could not start consumer");
    }
  }

  async function loop(messages: ConsumerMessages, bridge: Bridge): Promise<void> {
    try {
      for await (const message of messages) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(decoder.decode(message.data));
        } catch {
          parsed = null;
        }
        const event = bridge.parse(parsed);
        if (!event) {
          log.warn({ subject: message.subject }, "ignored invalid payload");
          message.ack();
          continue;
        }
        // fire() records its own outcome (matched / FAILED / DROPPED runs); a throw here is a
        // misconfigured automation, already in the audit, so the message is acked either way.
        await fw
          .fire(bridge.type, bridge.toPayload(event as never), { id: event.id, cause: event.cause })
          .catch((err: unknown) => log.error({ err, type: bridge.type, eventId: event.id }, "fire failed"));
        message.ack();
      }
    } catch (err) {
      log.error({ err, type: bridge.type }, "consumer loop stopped");
    }
  }

  return async () => {
    for (const m of running) m.stop();
    await nc.drain();
  };
}
