// Rebuilds metric buckets after a shift amendment (ADR-0015). Lives in the
// rollups worker beside the job-history rebuild for the same reasons.

import {
  AckPolicy,
  type ConsumerMessages,
  DeliverPolicy,
  DiscardPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
} from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import {
  deriveShiftHistoryEventSubject,
  parseShiftHistoryEvent,
  SHIFT_HISTORY_EVENT_STREAM,
  SHIFT_HISTORY_EVENT_SUBJECT_FILTER,
} from "@rw/runtime/shift-history-events";
import { shift } from "@rw/services/facility/index";

const DURABLE = "rw-workers-shift-history-rebuild";
const ACK_WAIT_NANOS = 10 * 60 * 1_000_000_000;
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

let nc: NatsConnection | null = null;
let messages: ConsumerMessages | null = null;

export async function startShiftHistoryRebuild(): Promise<void> {
  nc = await connect({
    servers: (process.env.NATS_URL ?? "nats://localhost:4222").split(",").map((s) => s.trim()),
    name: DURABLE,
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  const jsm = await jetstreamManager(nc);
  try {
    await jsm.streams.info(SHIFT_HISTORY_EVENT_STREAM);
  } catch {
    await jsm.streams.add({
      name: SHIFT_HISTORY_EVENT_STREAM,
      subjects: [SHIFT_HISTORY_EVENT_SUBJECT_FILTER],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_msgs: 100_000,
      max_age: WEEK_NANOS,
      duplicate_window: TWO_MINUTES_NANOS,
    });
  }
  const filter = `shift-history.*.*.amended`;
  try {
    await jsm.consumers.info(SHIFT_HISTORY_EVENT_STREAM, DURABLE);
  } catch {
    await jsm.consumers.add(SHIFT_HISTORY_EVENT_STREAM, {
      durable_name: DURABLE,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      filter_subject: filter,
      ack_wait: ACK_WAIT_NANOS,
      max_deliver: 3,
    });
  }
  const js = jetstream(nc);
  const consumer = await js.consumers.get(SHIFT_HISTORY_EVENT_STREAM, DURABLE);
  messages = await consumer.consume({ max_messages: 1 });
  void (async () => {
    for await (const msg of messages ?? []) {
      const event = parseShiftHistoryEvent(JSON.parse(decoder.decode(msg.data)));
      if (!event) {
        console.warn(`[shift-history-rebuild] malformed event on ${msg.subject}; dropping`);
        msg.ack();
        continue;
      }
      let status: "APPLIED" | "FAILED" = "APPLIED";
      try {
        await shift.amend.rebuildForShiftAmendment(event.amendmentId);
        msg.ack();
      } catch (err) {
        status = "FAILED";
        console.error(`[shift-history-rebuild] amendment ${event.amendmentId} failed:`, err);
        msg.nak(30_000);
      }
      const rebuilt = {
        ...event,
        id: `${event.id}:rebuilt`,
        action: "rebuilt" as const,
        status,
        emittedAt: new Date().toISOString(),
      };
      await js.publish(
        deriveShiftHistoryEventSubject({ siteId: event.siteId, workCenterId: event.workCenterId, action: "rebuilt" }),
        encoder.encode(JSON.stringify(rebuilt)),
        { msgID: rebuilt.id },
      );
    }
  })();
  console.log(`[shift-history-rebuild] consuming ${filter}`);
}

export async function stopShiftHistoryRebuild(): Promise<void> {
  messages?.stop();
  messages = null;
  if (nc && !nc.isClosed()) await nc.drain();
  nc = null;
}
