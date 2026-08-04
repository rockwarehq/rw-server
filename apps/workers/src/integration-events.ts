// Consumes ALL livestore hook events and dispatches matching IntegrationTriggers:
// match -> resolve $from template -> executeAction -> IntegrationRun row.
// Needs DATABASE_URL, NATS_URL, INTEGRATION_ENCRYPTION_KEY.

import { AckPolicy, DeliverPolicy, type ConsumerMessages, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import {
  closeSqlServerPools,
  createDefaultIntegrationRegistry,
  executeAction,
  resolveInputTemplate,
} from "@rw/integrations";
import { LIVESTORE_EVENT_STREAM, type LivestoreHookEvent } from "@rw/livestore/catalog/events";
import { ensureLivestoreEventStream } from "@rw/livestore/catalog/event-stream";
import { triggers } from "@rw/livestore/graph/index";
import { integrationRuns, integrations } from "@rw/services/integration/index";

export const INTEGRATION_EVENT_DURABLE = "rw-workers-integration-events";
const ACK_WAIT_NANOS = 60 * 1_000_000_000; // covers a slow stored procedure

const decoder = new TextDecoder();
const registry = createDefaultIntegrationRegistry();

let nc: NatsConnection | null = null;
let messages: ConsumerMessages | null = null;

export async function startIntegrationEvents(): Promise<void> {
  nc = await connect({
    servers: process.env.NATS_URL || "nats://localhost:4222",
    name: process.env.NATS_CLIENT_NAME || "rw-workers-integration-events",
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  const { jetstream, jetstreamManager } = await import("@nats-io/jetstream");
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await ensureLivestoreEventStream(jsm);
  await ensureConsumer(jsm);

  const consumer = await js.consumers.get(LIVESTORE_EVENT_STREAM, INTEGRATION_EVENT_DURABLE);
  messages = await consumer.consume({ max_messages: 50 });
  void dispatch(messages);
  console.log(`[integration-events] consumer started (durable=${INTEGRATION_EVENT_DURABLE})`);
}

export async function stopIntegrationEvents(): Promise<void> {
  messages?.stop();
  messages = null;
  if (nc && !nc.isClosed()) await nc.drain();
  nc = null;
  await closeSqlServerPools();
}

async function ensureConsumer(jsm: JetStreamManager): Promise<void> {
  try {
    await jsm.consumers.info(LIVESTORE_EVENT_STREAM, INTEGRATION_EVENT_DURABLE);
  } catch {
    await jsm.consumers.add(LIVESTORE_EVENT_STREAM, {
      durable_name: INTEGRATION_EVENT_DURABLE,
      ack_policy: AckPolicy.Explicit,
      // New on first creation only; across restarts the durable resumes from its last ack.
      deliver_policy: DeliverPolicy.New,
      // Every hook event: triggers can bind any namespace, not just imm.
      filter_subject: "livestore.events.>",
      ack_wait: ACK_WAIT_NANOS,
    });
  }
}

async function dispatch(stream: ConsumerMessages): Promise<void> {
  try {
    for await (const message of stream) {
      const event = parseEvent(message.data);
      if (!event) {
        console.warn(`[integration-events] ignored invalid payload on ${message.subject}`);
        message.ack();
        continue;
      }
      try {
        await handleEvent(event);
        message.ack();
      } catch (err) {
        // Only infra errors (DB down) land here — action failures become FAILED runs.
        console.error(`[integration-events] handling failed for ${event.type} (${event.id}):`, err);
        message.nak(5_000);
      }
    }
  } catch (err) {
    console.error("[integration-events] consumer loop stopped:", err);
  }
}

async function handleEvent(event: LivestoreHookEvent): Promise<void> {
  const matched = await triggers.matching({
    siteId: event.siteId,
    eventNamespace: event.namespace,
    eventName: event.name,
    eventVersion: event.version,
    hookId: event.hookId,
  });

  for (const trigger of matched) {
    await runTrigger(trigger, event);
  }
}

type MatchedTrigger = Awaited<ReturnType<typeof triggers.matching>>[number];

async function runTrigger(trigger: MatchedTrigger, event: LivestoreHookEvent): Promise<void> {
  const resolved = resolveInputTemplate(trigger.input, event.payload);

  const started = await integrationRuns.start({
    integrationId: trigger.integrationId,
    actionKey: trigger.actionKey,
    actionVersion: trigger.actionVersion,
    triggerType: "hook",
    triggerId: trigger.id,
    input: "error" in resolved ? {} : (resolved.data as Record<string, unknown>),
    // One event can fan out to several triggers; the pair is the delivery identity.
    dedupeKey: `${event.id}:${trigger.id}`,
  });
  if ("error" in started) {
    if (started.code !== "DUPLICATE_RUN") console.error(`[integration-events] run start failed: ${started.error}`);
    return;
  }

  if ("error" in resolved) {
    await integrationRuns.finish(started.data.id, {
      status: "FAILED",
      error: `${resolved.code}: ${resolved.error}`,
    });
    return;
  }

  const record = await integrations.loadForExecution(trigger.integrationId);
  if ("error" in record) {
    await integrationRuns.finish(started.data.id, { status: "FAILED", error: `${record.code}: ${record.error}` });
    return;
  }

  const outcome = await executeAction(registry, record.data, trigger.actionKey, trigger.actionVersion, resolved.data);
  await integrationRuns.finish(
    started.data.id,
    "error" in outcome
      ? { status: "FAILED", error: `${outcome.code}: ${outcome.error}` }
      : { status: "SUCCEEDED", result: outcome.data },
  );
}

function parseEvent(data: Uint8Array): LivestoreHookEvent | null {
  try {
    const parsed = JSON.parse(decoder.decode(data)) as Partial<LivestoreHookEvent>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string" || typeof parsed.siteId !== "string" || typeof parsed.hookId !== "string") {
      return null;
    }
    if (typeof parsed.namespace !== "string" || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
      return null;
    }
    if (!parsed.payload || typeof parsed.payload !== "object") return null;
    return parsed as LivestoreHookEvent;
  } catch {
    return null;
  }
}
