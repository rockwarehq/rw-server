import { DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { getNatsClient } from "./nats.js";
import type { MqttIngestEvent } from "./types.js";

const encoder = new TextEncoder();

export function livestreamStreamName(): string {
  return process.env.LIVESTORE_JS_STREAM || "LIVESTORE_MQTT_INGEST";
}

export function livestreamSubjectPrefix(): string {
  return normalizeSubjectPrefix(process.env.LIVESTORE_JS_SUBJECT_PREFIX || "livestore.mqtt");
}

export async function ensureMqttIngestStream(): Promise<void> {
  const { jetstreamManager } = getNatsClient();
  const name = livestreamStreamName();
  const subjects = [`${livestreamSubjectPrefix()}.>`];

  try {
    const info = await jetstreamManager.streams.info(name);
    const missingSubjects = subjects.filter((subject) => !info.config.subjects.includes(subject));
    if (missingSubjects.length > 0) {
      await jetstreamManager.streams.update(name, {
        subjects: [...info.config.subjects, ...missingSubjects],
      });
      console.log(`[livestore] updated JetStream stream ${name} for ${missingSubjects.join(",")}`);
    }
    return;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  await jetstreamManager.streams.add({
    name,
    subjects,
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_consumers: -1,
    max_msgs: -1,
    max_bytes: -1,
    max_age: 0,
    max_msg_size: -1,
    max_msgs_per_subject: -1,
    duplicate_window: 0,
  });

  console.log(`[livestore] ensured JetStream stream ${name} for ${subjects.join(",")}`);
}

export async function publishMqttIngestEvent(event: MqttIngestEvent): Promise<void> {
  const payload = encoder.encode(JSON.stringify(event));
  await getNatsClient().jetstream.publish(event.subject, payload);
}

function normalizeSubjectPrefix(prefix: string): string {
  const normalized = prefix
    .split(".")
    .map((token) => sanitizeSubjectToken(token))
    .filter(Boolean)
    .join(".");

  return normalized || "livestore.mqtt";
}

function sanitizeSubjectToken(token: string): string {
  return token.trim().replaceAll(/[^A-Za-z0-9_-]/g, "_");
}

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const message = err.message.toLowerCase();
  return message.includes("not found") || message.includes("stream not found");
}
