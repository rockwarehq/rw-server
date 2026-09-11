// Rebuilds metric buckets after a job history amendment. Lives in the rollups
// worker: it needs the direct DB URL and must not race the bucket pipeline.

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
  JOB_HISTORY_EVENT_STREAM,
  JOB_HISTORY_EVENT_SUBJECT_FILTER,
  parseJobHistoryAmendedEvent,
} from "@rw/runtime/job-history-events";
import { deriveUiChangeSubject } from "@rw/runtime/ui-change-events";
import { setUiChangeSink } from "@rw/services/events/ui-changes";
import { rebuildForAmendment } from "@rw/services/history/index";

const DURABLE = "rw-workers-job-history-rebuild";
const ACK_WAIT_NANOS = 10 * 60 * 1_000_000_000;
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

let nc: NatsConnection | null = null;
let messages: ConsumerMessages | null = null;

export async function startJobHistoryRebuild(): Promise<void> {
  nc = await connect({
    servers: (process.env.NATS_URL ?? "nats://localhost:4222").split(",").map((s) => s.trim()),
    name: "rw-workers-job-history-rebuild",
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  const conn = nc;
  setUiChangeSink(async (event) => {
    conn.publish(deriveUiChangeSubject(event.siteId), encoder.encode(JSON.stringify(event)));
  });
  const jsm = await jetstreamManager(nc);
  // Same config apps/api ensureStream uses, so whichever process comes up first creates it identically.
  try {
    await jsm.streams.info(JOB_HISTORY_EVENT_STREAM);
  } catch {
    await jsm.streams.add({
      name: JOB_HISTORY_EVENT_STREAM,
      subjects: [JOB_HISTORY_EVENT_SUBJECT_FILTER],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_msgs: 100_000,
      max_age: WEEK_NANOS,
      duplicate_window: TWO_MINUTES_NANOS,
    });
  }
  try {
    await jsm.consumers.info(JOB_HISTORY_EVENT_STREAM, DURABLE);
  } catch {
    await jsm.consumers.add(JOB_HISTORY_EVENT_STREAM, {
      durable_name: DURABLE,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      filter_subject: JOB_HISTORY_EVENT_SUBJECT_FILTER,
      ack_wait: ACK_WAIT_NANOS,
      max_deliver: 3,
    });
  }
  const consumer = await jetstream(nc).consumers.get(JOB_HISTORY_EVENT_STREAM, DURABLE);
  messages = await consumer.consume({ max_messages: 1 });
  void (async () => {
    for await (const msg of messages ?? []) {
      const event = parseJobHistoryAmendedEvent(JSON.parse(decoder.decode(msg.data)));
      if (!event) {
        console.warn(`[job-history-rebuild] malformed event on ${msg.subject}; dropping`);
        msg.ack();
        continue;
      }
      try {
        await rebuildForAmendment(event.amendmentId, event.displacedJobIds);
        console.log(`[job-history-rebuild] rebuilt amendment ${event.amendmentId} station=${event.stationId}`);
        msg.ack();
      } catch (err) {
        console.error(`[job-history-rebuild] amendment ${event.amendmentId} failed:`, err);
        msg.nak(30_000);
      }
    }
  })();
  console.log(`[job-history-rebuild] consuming ${JOB_HISTORY_EVENT_SUBJECT_FILTER}`);
}

export async function stopJobHistoryRebuild(): Promise<void> {
  setUiChangeSink(null);
  messages?.stop();
  messages = null;
  if (nc && !nc.isClosed()) await nc.drain();
  nc = null;
}
