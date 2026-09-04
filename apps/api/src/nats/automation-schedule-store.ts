import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  JetStreamApiError,
  jetstreamManager,
  RetentionPolicy,
} from "@nats-io/jetstream";
import { headers } from "@nats-io/transport-node";
import type { ScheduledAction, ScheduleStore } from "@rw/automations";
import { moduleLogger } from "../logger.js";
import { ensureStream, getNatsConnection } from "./util.js";

// Delayed automation actions as JetStream scheduled messages (server 2.12+). One schedule per
// (automation, action, scope) subject; when due the server republishes it onto the matching `due`
// subject, which a durable work-queue consumer hands to exactly one api instance. Arm-if-absent is
// the expected-last-subject-sequence 0 header, cancel is a purge by subject, and a one-shot
// schedule removes itself after firing. A non-repeating entry then re-occupies its key with a plain
// hold message so later matches can't re-arm until cancel purges it.

const log = moduleLogger("automation-schedule-store");
const decoder = new TextDecoder();
const STREAM = "RW_AUTOMATION_SCHEDULES";
const SCHEDULE = "automations.schedule";
const DUE = "automations.due";
const DURABLE = "rw-api-automation-due";
const ACK_WAIT_NANOS = 60 * 1_000_000_000;
const WRONG_LAST_SEQUENCE = 10071;

/** Scope values are opaque strings; base64url keeps each one a single valid subject token. */
const token = (scope: string) => (scope ? Buffer.from(scope).toString("base64url") : "_");

/** Throws when NATS is unavailable: delayed actions have no other home, so the app must not boot without it. */
export async function createNatsScheduleStore(): Promise<ScheduleStore> {
  const nc = await getNatsConnection();
  if (!nc) throw new Error("automation delayed actions need NATS (set NATS_URL)");
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  // Work-queue retention: fired entries leave on ack; schedules purge themselves. No age limit,
  // or a long delay would be dropped before it fires.
  await ensureStream(jsm, STREAM, `${SCHEDULE}.>`, {
    subjects: [`${SCHEDULE}.>`, `${DUE}.>`],
    retention: RetentionPolicy.Workqueue,
    allow_msg_schedules: true,
    max_age: 0,
    max_msgs: -1,
  });

  const subject = (e: ScheduledAction) => `${SCHEDULE}.${e.automationId}.${e.actionIdx}.${token(e.scope)}`;

  /** Publish onto the key's subject only if it is empty. False when something already occupies it. */
  async function occupy(e: ScheduledAction, body: string, extra: Record<string, string>): Promise<boolean> {
    const h = headers();
    h.set("Nats-Expected-Last-Subject-Sequence", "0");
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    try {
      await js.publish(subject(e), body, { headers: h });
      return true;
    } catch (err) {
      if (err instanceof JetStreamApiError && err.code === WRONG_LAST_SEQUENCE) return false;
      throw err;
    }
  }

  return {
    schedule: (entry) =>
      occupy(entry, JSON.stringify(entry), {
        "Nats-Schedule": `@at ${new Date(entry.runAt).toISOString()}`,
        "Nats-Schedule-Target": subject(entry).replace(SCHEDULE, DUE),
      }),

    async cancel(automationId, scope) {
      await jsm.streams.purge(STREAM, { filter: `${SCHEDULE}.${automationId}.*.${token(scope)}` });
    },

    async start(handler) {
      await jsm.consumers.info(STREAM, DURABLE).catch(() =>
        jsm.consumers.add(STREAM, {
          durable_name: DURABLE,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
          filter_subject: `${DUE}.>`,
          ack_wait: ACK_WAIT_NANOS,
        }),
      );
      const consumer = await js.consumers.get(STREAM, DURABLE);
      const messages = await consumer.consume({ max_messages: 50 });
      void (async () => {
        try {
          for await (const message of messages) {
            // The handler records its own outcome; a throw (or an unparseable entry) is logged and
            // the message is acked either way so the loop never wedges on one entry.
            try {
              const entry = JSON.parse(decoder.decode(message.data)) as ScheduledAction;
              await handler(entry);
              if (!entry.repeat) await occupy(entry, "held", {});
            } catch (err) {
              log.error({ err, subject: message.subject }, "delayed action failed");
            }
            message.ack();
          }
        } catch (err) {
          log.error({ err }, "consumer loop stopped");
        }
      })();
      log.info({ stream: STREAM, durable: DURABLE }, "receiving due delayed actions");
      return async () => messages.stop();
    },
  };
}
