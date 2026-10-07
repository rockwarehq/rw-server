import { AckPolicy, type ConsumerMessages, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { LIVESTORE_EVENT_STREAM, type LivestoreHookEvent } from "@rw/livestore/catalog/events";
import { ensureLivestoreEventStream } from "@rw/livestore/catalog/event-stream";

import { fireHookEvent } from "../agent/triggers.js";
import { moduleLogger } from "../logger.js";
import { getNatsConnection } from "./util.js";

// LiveStore hook events -> agent triggers. Like the integration-events worker,
// a durable consumer on RW_LIVESTORE_EVENTS; matching triggers each start an
// agent run (deduped by event id, so a redelivery starts nothing new).

const log = moduleLogger("agent-trigger-consumer");
const DURABLE = "rw-api-agent-triggers";
const ACK_WAIT_NANOS = 60 * 1_000_000_000;
const decoder = new TextDecoder();

export async function startAgentTriggerConsumer(): Promise<() => Promise<void>> {
  const nc = await getNatsConnection();
  if (!nc) return async () => {};
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  let messages: ConsumerMessages;
  try {
    await ensureLivestoreEventStream(jsm);
    await jsm.consumers.info(LIVESTORE_EVENT_STREAM, DURABLE).catch(() =>
      jsm.consumers.add(LIVESTORE_EVENT_STREAM, {
        durable_name: DURABLE,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
        ack_wait: ACK_WAIT_NANOS,
      }),
    );
    messages = await (await js.consumers.get(LIVESTORE_EVENT_STREAM, DURABLE)).consume({ max_messages: 50 });
  } catch (err) {
    log.error({ err }, "could not start agent trigger consumer");
    return async () => {};
  }

  void (async () => {
    try {
      for await (const message of messages) {
        let event: LivestoreHookEvent | null = null;
        try {
          event = JSON.parse(decoder.decode(message.data)) as LivestoreHookEvent;
        } catch {
          event = null;
        }
        if (!event?.id || !event.siteId) {
          message.ack();
          continue;
        }
        try {
          await fireHookEvent(event);
          message.ack();
        } catch (err) {
          log.error({ err, eventId: event.id }, "agent triggers failed; retrying");
          message.nak(5000);
        }
      }
    } catch (err) {
      log.error({ err }, "agent trigger consumer stopped");
    }
  })();

  log.info({ durable: DURABLE }, "agent trigger consumer started");
  return async () => {
    messages.stop();
  };
}
