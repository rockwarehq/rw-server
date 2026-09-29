import { createHash } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { type Automation, isScheduledRun, localTime, nextDailyRun } from "@rw/automations";
import { bullmqConfig, bullmqConnectionOpts } from "@rw/runtime/bullmq-config";
import { getSiteTimezone } from "@rw/services/metrics/bucket";
import { infraConfig } from "../config.js";
import { moduleLogger } from "../logger.js";
import { fromClock, schema as timeDaily } from "./events/time-daily.js";
import { getAutomationFramework } from "./index.js";

// Clock-triggered automations, scheduled through BullMQ (Redis). Each enabled `time.daily`
// automation keeps a single delayed job on the `automation-clock` queue — its jobId the automation
// id — due at the automation's next run in the site's timezone (BullMQ can't take one, so the time
// is computed here and DST is handled). When the job fires we raise `time.daily` at that automation
// alone, then arm the next day's job. A create/update re-arms; a disable or delete removes.
// A run that comes due while the api is down waits in Redis and fires late once a worker is back.
//
// This replaced a NATS JetStream `@at` scheduler: message schedules need NATS 2.11+, and the fleet's
// brokers are 2.10, so ticks never fired. BullMQ is the plant's proven timer layer (shift-change,
// shift-bucket-create) and carries no such version dependency.

const log = moduleLogger("automation-clock");
const QUEUE = "automation-clock";
// Successful ticks don't linger; keep a bounded tail of failures for debugging.
const KEEP_FAILED = { count: 50 };

interface Tick {
  automationId: string;
  runAt: string;
}

type Clocked = Automation & { partition: string; schedule: NonNullable<Automation["schedule"]> };

const isClocked = (a: Automation): a is Clocked =>
  a.event === timeDaily.type && a.enabled && !!a.schedule && !!a.partition;

let queue: Queue | null = null;
let worker: Worker | null = null;

/** The shared producer queue, or null when Redis isn't configured (clock disabled). */
function ensureQueue(): Queue | null {
  if (queue) return queue;
  if (!infraConfig.redisUrl) return null;
  queue = new Queue(QUEUE, { connection: bullmqConnectionOpts() });
  return queue;
}

/** Arm the automation's next run, replacing any job already armed for it. */
async function arm(a: Clocked): Promise<void> {
  const q = ensureQueue();
  if (!q) return;
  const runAt = nextDailyRun(a.schedule, await getSiteTimezone(a.partition), new Date());
  const tick: Tick = { automationId: a.id, runAt: runAt.toISOString() };
  try {
    // One job per automation (jobId = its id): removing first keeps a re-arm from clashing with the
    // job already waiting. A job mid-fire can't be removed; its own completion arms the next run.
    await q.remove(a.id);
    await q.add("tick", tick, {
      jobId: a.id,
      delay: Math.max(0, runAt.getTime() - Date.now()),
      removeOnComplete: true,
      removeOnFail: KEEP_FAILED,
    });
  } catch (err) {
    log.warn({ err, automationId: a.id }, "arm failed");
  }
}

/** Re-arm one automation by id, once its fired job has left the queue. */
async function rearmById(automationId: string): Promise<void> {
  const a = (await getAutomationFramework()).store.get(automationId);
  if (a && isClocked(a)) await arm(a);
}

/** After a create, update, or delete: drop the armed run and arm one from the current definition. */
export async function rearmClock(a: Automation, removed = false): Promise<void> {
  if (a.event !== timeDaily.type) return;
  const q = ensureQueue();
  if (!q) return;
  await q.remove(a.id).catch(() => {});
  if (!removed && isClocked(a)) await arm(a);
}

/** A run's event id: a UUID derived from the automation and its planned time. */
export function runEventId(automationId: string, runAt: Date): string {
  const hex = createHash("sha256").update(`${automationId}:${runAt.toISOString()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function onTick(tick: Tick): Promise<void> {
  const fw = await getAutomationFramework();
  const a = fw.store.get(tick.automationId);
  if (!a || !isClocked(a)) return;
  const runAt = new Date(tick.runAt);
  const timezone = await getSiteTimezone(a.partition);
  // A run armed under an older schedule no longer matches it; the edit armed the right one.
  if (isScheduledRun(a.schedule, timezone, runAt)) {
    await fw
      .fire(timeDaily.type, fromClock(a.partition, runAt, localTime(runAt, timezone)), {
        target: a.id,
        // The same run always has the same event id, so a redelivered tick can't send twice.
        id: runEventId(a.id, runAt),
      })
      .catch((err: unknown) => log.error({ err, automationId: a.id }, "fire failed"));
  }
}

export async function startAutomationClock(): Promise<() => Promise<void>> {
  const q = ensureQueue();
  if (!q) {
    log.info("REDIS_URL not set, automation clock disabled");
    return async () => {};
  }
  worker = new Worker(
    QUEUE,
    async (job) => {
      await onTick(job.data as Tick);
    },
    {
      connection: bullmqConnectionOpts(),
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );
  // The next day's job is armed once the fired one has left the queue (its jobId is then free),
  // whether it succeeded or failed, so a failed fire doesn't break the daily cadence.
  worker.on("completed", (job) => void rearmById((job.data as Tick).automationId));
  worker.on("failed", (job, err) => {
    const automationId = (job?.data as Tick | undefined)?.automationId;
    log.error({ err, automationId }, "tick failed");
    if (automationId) void rearmById(automationId);
  });
  worker.on("error", (err) => log.error({ err }, "automation clock worker error"));

  // Reconcile on boot: arm any clock automation without a job. An armed job is left alone — a
  // now-due one fires immediately, so a run missed during downtime still lands late.
  const fw = await getAutomationFramework();
  for (const a of fw.store.list()) {
    if (isClocked(a) && !(await q.getJob(a.id))) await arm(a);
  }
  log.info({ queue: QUEUE }, "running the automation clock");
  return async () => {
    await worker?.close();
    await queue?.close();
    worker = null;
    queue = null;
  };
}
