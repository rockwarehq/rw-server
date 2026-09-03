import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import {
  deriveGraphDefinitionSubject,
  GRAPH_DEFINITION_STREAM,
  GRAPH_DEFINITION_SUBJECT_FILTER,
  type GraphDefinitionEvent,
} from "@rw/livestore/catalog/definitions";
import { setGraphDefinitionEventSink } from "@rw/livestore/graph/index";
import { moduleLogger } from "../logger.js";
import { ensureStream, getNatsConnection } from "./util.js";

const log = moduleLogger("graph-definition-publisher");

const encoder = new TextEncoder();

export async function startGraphDefinitionPublisher(): Promise<() => Promise<void>> {
  const nc = await getNatsConnection();
  if (!nc) return async () => {};

  try {
    await ensureStream(await jetstreamManager(nc), GRAPH_DEFINITION_STREAM, GRAPH_DEFINITION_SUBJECT_FILTER);
  } catch (err) {
    log.error({ err }, "could not ensure JetStream stream, graph definition events disabled");
    return async () => {};
  }
  const js = jetstream(nc);

  setGraphDefinitionEventSink(async (event) => {
    const subject = deriveGraphDefinitionSubject(event.siteId);
    await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id }).catch((err: unknown) => {
      log.error({ err, event }, "publish failed");
    });
  });

  log.info("publishing graph definition events");

  return async () => setGraphDefinitionEventSink(null);
}

export type { GraphDefinitionEvent };
