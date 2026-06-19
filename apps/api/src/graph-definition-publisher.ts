import { jetstream, jetstreamManager, DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  deriveGraphDefinitionSubject,
  GRAPH_DEFINITION_STREAM,
  GRAPH_DEFINITION_SUBJECT_FILTER,
  type GraphDefinitionEvent,
} from "@rw/runtime/graph-definitions";
import { setGraphDefinitionEventSink } from "@rw/services/graph/index";

const encoder = new TextEncoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

export async function startGraphDefinitionPublisher(): Promise<() => Promise<void>> {
  const servers = process.env.NATS_URL;
  if (!servers) {
    console.log("[graph-definition-publisher] NATS_URL not set, graph definition events disabled");
    return async () => {};
  }

  const nc = await connect({
    servers: natsServers(servers),
    name: process.env.NATS_CLIENT_NAME || "rw-api-graph-definitions",
    maxReconnectAttempts: -1,
  }).catch((err: unknown) => {
    console.error("[graph-definition-publisher] could not connect to NATS, graph definition events disabled", err);
    return null;
  });
  if (!nc) return async () => {};

  const jsm = await jetstreamManager(nc);
  try {
    await ensureGraphDefinitionStream(jsm);
  } catch (err) {
    console.error("[graph-definition-publisher] could not ensure JetStream stream, graph definition events disabled", err);
    await nc.drain();
    return async () => {};
  }
  const js = jetstream(nc);

  setGraphDefinitionEventSink(async (event) => {
    const subject = deriveGraphDefinitionSubject(event.siteId);
    await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id }).catch((err: unknown) => {
      console.error("[graph-definition-publisher] publish failed", { err, event });
    });
  });

  console.log(`[graph-definition-publisher] publishing graph definition events to ${nc.getServer()}`);

  return async () => {
    setGraphDefinitionEventSink(null);
    await nc.drain();
  };
}

async function ensureGraphDefinitionStream(jsm: Awaited<ReturnType<typeof jetstreamManager>>): Promise<void> {
  try {
    const info = await jsm.streams.info(GRAPH_DEFINITION_STREAM);
    const subjects = new Set(info.config.subjects ?? []);
    if (!subjects.has(GRAPH_DEFINITION_SUBJECT_FILTER)) {
      await jsm.streams.update(GRAPH_DEFINITION_STREAM, {
        subjects: [...subjects, GRAPH_DEFINITION_SUBJECT_FILTER],
      });
    }
    return;
  } catch {
    await jsm.streams.add({
      name: GRAPH_DEFINITION_STREAM,
      subjects: [GRAPH_DEFINITION_SUBJECT_FILTER],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_msgs: 100_000,
      max_age: WEEK_NANOS,
      duplicate_window: TWO_MINUTES_NANOS,
    });
  }
}

function natsServers(value: string): string | string[] {
  const servers = value
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length === 1) return servers[0] as string;
  return servers;
}

export type { GraphDefinitionEvent };
