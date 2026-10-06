import { isScheduledRun, nextDailyRun } from "@rw/automations";
import prisma from "@rw/db";
import { bullmqConfig, bullmqConnectionOpts } from "@rw/runtime/bullmq-config";
import { getSiteTimezone } from "@rw/services/metrics/bucket";
import { Queue, Worker } from "bullmq";

import { infraConfig } from "../config.js";
import { moduleLogger } from "../logger.js";
import { fire, parseSchedule, type TriggerRow } from "./triggers.js";

// Scheduled agent triggers, on the same BullMQ pattern as the automation
// clock (automations/clock.ts): one delayed job per trigger (jobId = trigger
// id) due at its next run in the site's timezone, re-armed when it fires.
// BullMQ, not JetStream @at: the fleet's NATS brokers predate message schedules.

const log = moduleLogger("agent-clock");
const QUEUE = "agent-trigger-clock";
const KEEP_FAILED = { count: 50 };

interface Tick {
  triggerId: string;
  runAt: string;
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function ensureQueue(): Queue | null {
  if (queue) return queue;
  if (!infraConfig.redisUrl) return null;
  queue = new Queue(QUEUE, { connection: bullmqConnectionOpts() });
  return queue;
}

const isClocked = (trigger: TriggerRow) =>
  trigger.kind === "SCHEDULE" && trigger.enabled && !trigger.isDeleted && !!parseSchedule(trigger.schedule);

async function arm(trigger: TriggerRow): Promise<void> {
  const q = ensureQueue();
  const schedule = parseSchedule(trigger.schedule);
  if (!q || !schedule) return;
  const runAt = nextDailyRun(schedule, await getSiteTimezone(trigger.siteId), new Date());
  try {
    await q.remove(trigger.id);
    await q.add("tick", { triggerId: trigger.id, runAt: runAt.toISOString() } satisfies Tick, {
      jobId: trigger.id,
      delay: Math.max(0, runAt.getTime() - Date.now()),
      removeOnComplete: true,
      removeOnFail: KEEP_FAILED,
    });
  } catch (err) {
    log.warn({ err, triggerId: trigger.id }, "arm failed");
  }
}

/** After a create, update or delete: drop the armed run and arm from the current definition. */
export async function rearmAgentTrigger(triggerId: string): Promise<void> {
  const q = ensureQueue();
  if (!q) return;
  await q.remove(triggerId).catch(() => {});
  const trigger = await prisma.agentTrigger.findUnique({ where: { id: triggerId } });
  if (trigger && isClocked(trigger)) await arm(trigger);
}

/** "2026-10-06 12:10" in the site's zone, as the trigger was set up. */
function siteTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

export async function onTick(tick: Tick): Promise<void> {
  const trigger = await prisma.agentTrigger.findUnique({ where: { id: tick.triggerId } });
  const schedule = trigger ? parseSchedule(trigger.schedule) : null;
  if (!trigger || !schedule || !isClocked(trigger)) return;
  const runAt = new Date(tick.runAt);
  // A run armed under an older schedule no longer matches; the edit armed the right one.
  const timeZone = await getSiteTimezone(trigger.siteId);
  if (!isScheduledRun(schedule, timeZone, runAt)) return;
  await fire(trigger, {
    key: runAt.toISOString(),
    title: `${trigger.name}: ${siteTime(runAt, timeZone)}`,
    trigger: "SCHEDULE",
    event: { schedule: trigger.name, scheduledFor: runAt.toISOString() },
  });
}

export async function startAgentClock(): Promise<() => Promise<void>> {
  const q = ensureQueue();
  if (!q) {
    log.info("REDIS_URL not set, scheduled agent triggers disabled");
    return async () => {};
  }
  worker = new Worker(QUEUE, async (job) => onTick(job.data as Tick), {
    connection: bullmqConnectionOpts(),
    stalledInterval: bullmqConfig.stalledInterval,
    drainDelay: bullmqConfig.drainDelay,
  });
  const rearm = (triggerId?: string) => {
    if (triggerId) void rearmAgentTrigger(triggerId);
  };
  worker.on("completed", (job) => rearm((job.data as Tick).triggerId));
  worker.on("failed", (job, err) => {
    log.error({ err, triggerId: (job?.data as Tick | undefined)?.triggerId }, "tick failed");
    rearm((job?.data as Tick | undefined)?.triggerId);
  });
  worker.on("error", (err) => log.error({ err }, "agent clock worker error"));

  // Arm any scheduled trigger without a job; an armed one is left alone.
  const triggers = await prisma.agentTrigger.findMany({ where: { kind: "SCHEDULE", enabled: true, isDeleted: false } });
  for (const trigger of triggers) {
    if (!(await q.getJob(trigger.id))) await arm(trigger);
  }

  return async () => {
    await worker?.close();
    await queue?.close();
    worker = null;
    queue = null;
  };
}
