import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager, RetentionPolicy } from "@nats-io/jetstream";

import { moduleLogger } from "../logger.js";
import { ensureStream, getNatsConnection } from "../nats/util.js";

// The run queue. Anything that wants a session to make progress (a prompt,
// an approval, a trigger) enqueues it; whichever api node takes the message
// runs it, and the session's lease keeps two nodes from running it at once.
// JetStream work-queue when NATS is configured; in-process otherwise.

const log = moduleLogger("agent-queue");
const STREAM = "RW_AGENT_RUNS";
const SUBJECT = "agent.runs.>";
const DURABLE = "rw-api-agent-runs";
const ACK_WAIT_NANOS = 15 * 60 * 1_000_000_000;
const MAX_CONCURRENT = 8;

type Runner = (sessionId: string) => Promise<void>;

let runner: Runner | null = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The runner the queue drives; set once at startup (and by tests). */
export function setRunner(next: Runner | null): void {
  runner = next;
}

// Without NATS: run in this process, at most once at a time per session,
// with a follow-up when more work arrived meanwhile.
const local = new Map<string, { again: boolean }>();

function runLocally(sessionId: string): void {
  const active = local.get(sessionId);
  if (active) {
    active.again = true;
    return;
  }
  const state = { again: false };
  local.set(sessionId, state);
  void (async () => {
    try {
      do {
        state.again = false;
        await runner?.(sessionId);
      } while (state.again);
    } catch (err) {
      log.error({ err, sessionId }, "local run failed");
    } finally {
      local.delete(sessionId);
    }
  })();
}

export async function enqueueRun(sessionId: string, reason: string): Promise<void> {
  const nc = await getNatsConnection();
  if (!nc) {
    runLocally(sessionId);
    return;
  }
  await jetstream(nc).publish(`agent.runs.${sessionId}`, encoder.encode(JSON.stringify({ sessionId, reason })));
}

/** Local runs still in flight (tests wait on this). */
export async function drainLocalRuns(): Promise<void> {
  while (local.size > 0) await new Promise((resolve) => setTimeout(resolve, 10));
}

export async function startAgentRunConsumer(): Promise<() => Promise<void>> {
  const nc = await getNatsConnection();
  if (!nc) return async () => {};
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await ensureStream(jsm, STREAM, SUBJECT, { retention: RetentionPolicy.Workqueue });
  await jsm.consumers.info(STREAM, DURABLE).catch(() =>
    jsm.consumers.add(STREAM, {
      durable_name: DURABLE,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      ack_wait: ACK_WAIT_NANOS,
      max_ack_pending: MAX_CONCURRENT * 4,
    }),
  );
  const consumer = await js.consumers.get(STREAM, DURABLE);
  const messages = await consumer.consume({ max_messages: MAX_CONCURRENT });
  const inFlight = new Set<Promise<void>>();

  void (async () => {
    for await (const message of messages) {
      let sessionId: string | null = null;
      try {
        sessionId = (JSON.parse(decoder.decode(message.data)) as { sessionId?: string }).sessionId ?? null;
      } catch {
        sessionId = null;
      }
      if (!sessionId || !runner) {
        message.ack();
        continue;
      }
      // A run is acked when it ends; the session's lease, not the ack,
      // guarantees one runner. Keep pulling while runs proceed.
      const work = runner(sessionId)
        .catch((err: unknown) => log.error({ err, sessionId }, "run failed"))
        .finally(() => {
          message.ack();
          inFlight.delete(work);
        });
      inFlight.add(work);
      while (inFlight.size >= MAX_CONCURRENT) await Promise.race(inFlight);
    }
  })();

  log.info({ stream: STREAM, durable: DURABLE }, "agent run consumer started");
  return async () => {
    messages.stop();
    await Promise.allSettled([...inFlight]);
  };
}
