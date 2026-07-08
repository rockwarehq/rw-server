import { jetstream, jetstreamManager, DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  deriveGraphDefinitionSubject,
  GRAPH_DEFINITION_STREAM,
  GRAPH_DEFINITION_SUBJECT_FILTER,
  type GraphDefinitionEvent,
} from "@rw/livestore/catalog/definitions";
import { setGraphDefinitionEventSink } from "@rw/livestore/graph/index";
import { moduleLogger } from "../logger.js";
import { ensureStream, natsServers } from "./util.js";

const log = moduleLogger("graph-definition-publisher");

const encoder = new TextEncoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

export async function startGraphDefinitionPublisher(): Promise<() => Promise<void>> {
  const servers = process.env.NATS_URL;
  if (!servers) {
    log.info("NATS_URL not set, graph definition events disabled");
    return async () => {};
  }

  const nc = await connect({
    servers: natsServers(servers),
    name: process.env.NATS_CLIENT_NAME || "rw-api-graph-definitions",
    maxReconnectAttempts: -1,
  }).catch((err: unknown) => {
    log.error({ err }, "could not connect to NATS, graph definition events disabled");
    return null;
  });
  if (!nc) return async () => {};

  const jsm = await jetstreamManager(nc);
  try {
    await ensureGraphDefinitionStream(jsm);
  } catch (err) {
    log.error({ err }, "could not ensure JetStream stream, graph definition events disabled");
    await nc.drain();
    return async () => {};
  }
  const js = jetstream(nc);

  setGraphDefinitionEventSink(async (event) => {
    const subject = deriveGraphDefinitionSubject(event.siteId);
    await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id }).catch((err: unknown) => {
      log.error({ err, event }, "publish failed");
    });
  });

  log.info({ server: nc.getServer() }, "publishing graph definition events");

  return async () => {
    setGraphDefinitionEventSink(null);
    await nc.drain();
  };
}

function ensureGraphDefinitionStream(jsm: Awaited<ReturnType<typeof jetstreamManager>>): Promise<void> {
  return ensureStream(jsm, GRAPH_DEFINITION_STREAM, GRAPH_DEFINITION_SUBJECT_FILTER, {
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_msgs: 100_000,
    max_age: WEEK_NANOS,
    duplicate_window: TWO_MINUTES_NANOS,
  });
}

export type { GraphDefinitionEvent };
