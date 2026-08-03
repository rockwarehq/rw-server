// Shared RW_LIVESTORE_EVENTS stream ensure. The publisher (hook-manager), the
// imm-events worker, and dev scripts all race to create the stream, so every
// entry point goes through here to keep the config identical — and to
// reconcile limits on streams created by older deploys (the original
// max_msgs 100k cap silently discarded events under consumer backlog).

import { DiscardPolicy, RetentionPolicy, StorageType, type JetStreamManager } from "@nats-io/jetstream";
import { LIVESTORE_EVENT_STREAM, LIVESTORE_EVENT_SUBJECT_FILTER } from "./events.js";

const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

// ~2KB/event makes max_msgs the effective cap (~1M ≈ 2GB); max_bytes is the
// disk backstop if events grow. discard-old still applies at the cap, so lag
// alerting (imm_events_num_pending) is the real safety net against loss.
const LIVESTORE_EVENT_STREAM_LIMITS = {
  max_msgs: 1_000_000,
  max_bytes: 2 * 1024 * 1024 * 1024,
  max_age: WEEK_NANOS,
  duplicate_window: TWO_MINUTES_NANOS,
};

export async function ensureLivestoreEventStream(jsm: JetStreamManager): Promise<void> {
  const limits = LIVESTORE_EVENT_STREAM_LIMITS;
  try {
    const info = await jsm.streams.info(LIVESTORE_EVENT_STREAM);
    const cfg = info.config;
    const subjects = new Set(cfg.subjects ?? []);
    const drifted =
      !subjects.has(LIVESTORE_EVENT_SUBJECT_FILTER) ||
      cfg.max_msgs !== limits.max_msgs ||
      cfg.max_bytes !== limits.max_bytes ||
      cfg.max_age !== limits.max_age ||
      cfg.duplicate_window !== limits.duplicate_window;
    if (drifted) {
      subjects.add(LIVESTORE_EVENT_SUBJECT_FILTER);
      await jsm.streams.update(LIVESTORE_EVENT_STREAM, { subjects: [...subjects], ...limits });
    }
  } catch {
    await jsm.streams.add({
      name: LIVESTORE_EVENT_STREAM,
      subjects: [LIVESTORE_EVENT_SUBJECT_FILTER],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      ...limits,
    });
  }
}
