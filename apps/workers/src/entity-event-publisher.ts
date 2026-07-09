// Entity-event sink on an existing NATS connection: completeCycle in this process must publish entity.changes too.
// Stream config mirrors apps/api/src/nats/entity-event-publisher.ts — keep in sync.

import { DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import type { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { deriveEntityEventSubject, ENTITY_EVENT_STREAM, ENTITY_EVENT_SUBJECT_FILTER } from "@rw/runtime/entity-events";
import { setEntityEventSink } from "@rw/services/entity/index";

type Js = ReturnType<typeof jetstream>;
type Jsm = Awaited<ReturnType<typeof jetstreamManager>>;

const encoder = new TextEncoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

export async function installEntityEventSink(js: Js, jsm: Jsm): Promise<void> {
  try {
    const info = await jsm.streams.info(ENTITY_EVENT_STREAM);
    const subjects = new Set(info.config.subjects ?? []);
    if (!subjects.has(ENTITY_EVENT_SUBJECT_FILTER)) {
      await jsm.streams.update(ENTITY_EVENT_STREAM, { subjects: [...subjects, ENTITY_EVENT_SUBJECT_FILTER] });
    }
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

  setEntityEventSink(async (event) => {
    const subject = deriveEntityEventSubject(event);
    await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id }).catch((err: unknown) => {
      console.error("[entity-events] publish failed", err, event);
    });
  });
}

export function uninstallEntityEventSink(): void {
  setEntityEventSink(null);
}
