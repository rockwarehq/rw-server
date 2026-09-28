import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  JetStreamApiError,
  jetstreamManager,
  RetentionPolicy,
} from "@nats-io/jetstream";
import { headers } from "@nats-io/transport-node";
import { type Automation, localTime, nextDailyRun, scheduleMatches } from "@rw/automations";
import prisma from "@rw/db";
import { getAutomationFramework } from "../automations/index.js";
import { fromClock, schema as timeDaily } from "../automations/events/time-daily.js";
import { moduleLogger } from "../logger.js";
import { ensureStream, getNatsConnection } from "./util.js";

// Clock-triggered automations. Each one keeps a single JetStream `@at` message armed for its next
// run on `automations.clock.<id>`; when due the server republishes it onto `automations.tick.<id>`,
// a durable work-queue consumer fires `time.daily` at that automation alone and arms the run after.
// The next run is computed here in the site's timezone (the server's cron schedules can't take one),
// so DST is handled. A tick that comes due while the api is down waits in the stream and fires late.

const log = moduleLogger("automation-clock");
const decoder = new TextDecoder();
const STREAM = "RW_AUTOMATION_CLOCK";
const CLOCK = "automations.clock";
const TICK = "automations.tick";
const DURABLE = "rw-api-automation-tick";
const ACK_WAIT_NANOS = 60 * 1_000_000_000;
const WRONG_LAST_SEQUENCE = 10071;

interface Tick {
  automationId: string;
  runAt: string;
}

type Clocked = Automation & { partition: string; schedule: NonNullable<Automation["schedule"]> };

const isClocked = (a: Automation): a is Clocked =>
  a.event === timeDaily.type && a.enabled && !!a.schedule && !!a.partition;

let ready: Promise<{ js: ReturnType<typeof jetstream>; jsm: Awaited<ReturnType<typeof jetstreamManager>> }> | undefined;

function clock() {
  ready ??= (async () => {
    const nc = await getNatsConnection();
    if (!nc) throw new Error("clock-triggered automations need NATS (set NATS_URL)");
    const jsm = await jetstreamManager(nc);
    await ensureStream(jsm, STREAM, `${CLOCK}.>`, {
      subjects: [`${CLOCK}.>`, `${TICK}.>`],
      retention: RetentionPolicy.Workqueue,
      allow_msg_schedules: true,
      max_age: 0,
      max_msgs: -1,
    });
    return { js: jetstream(nc), jsm };
  })().catch((err: unknown) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

async function siteTimezone(siteId: string): Promise<string> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { timezone: true } });
  return site?.timezone ?? "UTC";
}

/** Arm the automation's first run after `after`, unless a run is already armed. */
async function arm(a: Clocked, after: Date): Promise<void> {
  const { js } = await clock();
  const runAt = nextDailyRun(a.schedule, await siteTimezone(a.partition), after);
  const h = headers();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  h.set("Nats-Schedule", `@at ${runAt.toISOString()}`);
  h.set("Nats-Schedule-Target", `${TICK}.${a.id}`);
  const tick: Tick = { automationId: a.id, runAt: runAt.toISOString() };
  try {
    await js.publish(`${CLOCK}.${a.id}`, JSON.stringify(tick), { headers: h });
  } catch (err) {
    if (!(err instanceof JetStreamApiError && err.code === WRONG_LAST_SEQUENCE)) throw err;
  }
}

/** After a create, update, or delete: drop the armed run and arm one from the current definition. */
export async function rearmClock(a: Automation, removed = false): Promise<void> {
  if (a.event !== timeDaily.type) return;
  const { jsm } = await clock();
  await jsm.streams.purge(STREAM, { filter: `${CLOCK}.${a.id}` });
  if (!removed && isClocked(a)) await arm(a, new Date());
}

async function onTick(tick: Tick): Promise<void> {
  const fw = await getAutomationFramework();
  const a = fw.store.get(tick.automationId);
  if (!a || !isClocked(a)) return;
  const runAt = new Date(tick.runAt);
  const local = localTime(runAt, await siteTimezone(a.partition));
  // A run armed under an older schedule no longer matches it; the edit armed the right one.
  if (scheduleMatches(a.schedule, local)) {
    await fw
      .fire(timeDaily.type, fromClock(a.partition, runAt, local), { target: a.id })
      .catch((err: unknown) => log.error({ err, automationId: a.id }, "fire failed"));
  }
  await arm(a, new Date(Math.max(Date.now(), runAt.getTime())));
}

export async function startAutomationClock(): Promise<() => Promise<void>> {
  const { js, jsm } = await clock();
  const fw = await getAutomationFramework();
  for (const a of fw.store.list()) {
    if (isClocked(a))
      await arm(a, new Date()).catch((err: unknown) => log.error({ err, automationId: a.id }, "arm failed"));
  }

  await jsm.consumers.info(STREAM, DURABLE).catch(() =>
    jsm.consumers.add(STREAM, {
      durable_name: DURABLE,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: `${TICK}.>`,
      ack_wait: ACK_WAIT_NANOS,
    }),
  );
  const messages = await (await js.consumers.get(STREAM, DURABLE)).consume({ max_messages: 50 });
  void (async () => {
    try {
      for await (const message of messages) {
        try {
          await onTick(JSON.parse(decoder.decode(message.data)) as Tick);
        } catch (err) {
          log.error({ err, subject: message.subject }, "tick failed");
        }
        message.ack();
      }
    } catch (err) {
      log.error({ err }, "consumer loop stopped");
    }
  })();
  log.info({ stream: STREAM, durable: DURABLE }, "running the automation clock");
  return async () => messages.stop();
}
