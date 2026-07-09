import type { jetstreamManager, StreamConfig } from "@nats-io/jetstream";

// Shared plumbing for the app's NATS adapters (see ADR-0004): parse the
// NATS_URL server list and idempotently ensure a JetStream stream exists
// with the adapter's subject filter attached.

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
 * Ensure `stream` exists and carries `subject` in its subject list. Existing
 * streams get the subject appended; missing streams are created with `config`.
 */
export async function ensureStream(
  jsm: Jsm,
  stream: string,
  subject: string,
  config: Partial<StreamConfig>,
): Promise<void> {
  try {
    const info = await jsm.streams.info(stream);
    const subjects = new Set(info.config.subjects ?? []);
    if (!subjects.has(subject)) {
      await jsm.streams.update(stream, { subjects: [...subjects, subject] });
    }
  } catch {
    await jsm.streams.add({ name: stream, subjects: [subject], ...config });
  }
}
