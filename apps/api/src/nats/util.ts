import {
  DiscardPolicy,
  type jetstreamManager,
  RetentionPolicy,
  StorageType,
  type StreamConfig,
} from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { moduleLogger } from "../logger.js";
import { registerReadinessCheck, unregisterReadinessCheck } from "../readiness.js";

// Shared plumbing for the app's NATS adapters (see ADR-0004): one process-wide
// connection every adapter borrows, plus an idempotent JetStream stream ensure.

const log = moduleLogger("nats");
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

let connection: Promise<NatsConnection | null> | null = null;

/**
 * The process's single NATS connection, dialed on first use. Resolves null (once, logged) when
 * NATS_URL is unset or the dial fails — adapters then disable themselves. Registered as a
 * non-critical readiness check: the app deliberately degrades without NATS.
 */
export function getNatsConnection(): Promise<NatsConnection | null> {
  connection ??= dial();
  return connection;
}

async function dial(): Promise<NatsConnection | null> {
  const servers = process.env.NATS_URL;
  if (!servers) {
    log.info("NATS_URL not set, NATS adapters disabled");
    return null;
  }
  try {
    const nc = await connect({
      servers: natsServers(servers),
      name: process.env.NATS_CLIENT_NAME || "rw-api",
      maxReconnectAttempts: -1,
    });
    registerReadinessCheck("nats", () => !nc.isClosed(), { critical: false });
    log.info({ server: nc.getServer() }, "connected to NATS");
    return nc;
  } catch (err) {
    log.error({ err }, "could not connect to NATS, NATS adapters disabled");
    return null;
  }
}

/** Drain the shared connection. Call after every adapter has stopped its sinks and consumers. */
export async function closeNatsConnection(): Promise<void> {
  const nc = await connection;
  connection = null;
  if (!nc) return;
  unregisterReadinessCheck("nats");
  await nc.drain();
}

export function natsServers(value: string): string | string[] {
  const servers = value
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length === 1) return servers[0] as string;
  return servers;
}

type Jsm = Awaited<ReturnType<typeof jetstreamManager>>;

/**
 * Ensure `stream` exists and carries `subject` in its subject list. Existing streams get the
 * subject appended; missing streams are created as file-backed, week-long, 100k-message
 * limits streams with id dedup, overridable via `config`.
 */
export async function ensureStream(
  jsm: Jsm,
  stream: string,
  subject: string,
  config: Partial<StreamConfig> = {},
): Promise<void> {
  try {
    const info = await jsm.streams.info(stream);
    const subjects = new Set(info.config.subjects ?? []);
    if (!subjects.has(subject)) {
      await jsm.streams.update(stream, { subjects: [...subjects, subject] });
    }
  } catch {
    await jsm.streams.add({
      name: stream,
      subjects: [subject],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_msgs: 100_000,
      max_age: WEEK_NANOS,
      duplicate_window: TWO_MINUTES_NANOS,
      ...config,
    });
  }
}
