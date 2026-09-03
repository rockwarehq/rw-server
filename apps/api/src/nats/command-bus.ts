import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  COMMAND_ACK_SUBJECT_FILTER,
  COMMAND_RESULT_SUBJECT_FILTER,
  COMMAND_STREAM,
  COMMAND_SUBJECT_FILTER,
  deriveGatewayCommandSubject,
  type CommandAck,
  type CommandEnvelope,
  type CommandResult,
} from "@rw/runtime/command-subjects";
import { commands as gatewayCommands } from "@rw/services/device/gateway/index";
import { moduleLogger } from "../logger.js";
import { ensureStream, getNatsConnection } from "./util.js";

const log = moduleLogger("command-bus");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DAY_NANOS = 24 * 60 * 60 * 1_000_000_000;

// Commands leave the cloud durably (JetStream) so a gateway that is offline when
// a command is queued still receives it on reconnect. Ack/result come back over
// core NATS (best-effort) and update the CommandQueue audit row.
export async function startCommandBus(): Promise<() => Promise<void>> {
  const nc = await getNatsConnection();
  if (!nc) return async () => {};

  try {
    await ensureStream(await jetstreamManager(nc), COMMAND_STREAM, COMMAND_SUBJECT_FILTER, {
      max_msgs: 10_000,
      max_age: DAY_NANOS,
    });
  } catch (err) {
    log.error({ err }, "could not ensure JetStream stream, gateway commands disabled");
    return async () => {};
  }
  const js = jetstream(nc);

  // Publish path: every persisted command is delivered to its gateway subject.
  gatewayCommands.setCommandSink((command) => {
    const subject = deriveGatewayCommandSubject(command.gatewayId);
    const envelope: CommandEnvelope = { id: command.id, command: command.command, payload: command.payload };
    js.publish(subject, encoder.encode(JSON.stringify(envelope)), { msgID: command.id }).catch((err: unknown) => {
      log.error({ err, command }, "command publish failed");
    });
  });

  // Lifecycle path: ack/result flow back over core NATS.
  const acks = nc.subscribe(COMMAND_ACK_SUBJECT_FILTER);
  const results = nc.subscribe(COMMAND_RESULT_SUBJECT_FILTER);
  void consumeAcks(acks);
  void consumeResults(results);

  log.info("publishing commands + consuming ack/result");

  return async () => {
    gatewayCommands.setCommandSink(null);
    acks.unsubscribe();
    results.unsubscribe();
  };
}

async function consumeAcks(sub: ReturnType<NatsConnection["subscribe"]>): Promise<void> {
  for await (const message of sub) {
    const ack = parse<CommandAck>(message.data);
    if (!ack?.gatewayId || !ack?.commandId) continue;
    await gatewayCommands.ack(ack.gatewayId, ack.commandId).catch((err: unknown) => {
      log.error({ err, ack }, "ack update failed");
    });
  }
}

async function consumeResults(sub: ReturnType<NatsConnection["subscribe"]>): Promise<void> {
  for await (const message of sub) {
    const res = parse<CommandResult>(message.data);
    if (!res?.gatewayId || !res?.commandId) continue;
    await gatewayCommands
      .complete(res.gatewayId, res.commandId, {
        success: res.success,
        data: (res.result as Record<string, unknown>) ?? undefined,
        error: res.error,
      })
      .catch((err: unknown) => {
        log.error({ err, res }, "result update failed");
      });
  }
}

function parse<T>(data: Uint8Array): T | null {
  try {
    return JSON.parse(decoder.decode(data)) as T;
  } catch {
    return null;
  }
}
