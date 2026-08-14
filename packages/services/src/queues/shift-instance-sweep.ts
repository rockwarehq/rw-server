// ── shift-instance-sweep — apps/workers/rollups ──────────────────
//
// Scheduled sweep (every 5 minutes) that guarantees ShiftInstance rows
// exist for "now" plus a short lookahead for every active ShiftAssignment
// (site-level and workcenter-level).
//
// The metric-bucket-ensure tick already materializes instances, but it is
// a self-chaining delayed job buried in a larger pipeline — if that chain
// breaks, instances silently stop being seeded and production falls back
// to clock-aligned hours. This sweep is an independent, repeating BullMQ
// job scheduler that closes that gap and loudly reports when it finds an
// active assignment with no instance covering "now" (the silent-fallback
// case).
//
// Idempotent and cheap: reuses materializeShiftInstances (createMany with
// skipDuplicates on the [assignmentId, startTime] unique constraint) with
// a short lookahead, so repeat runs insert nothing when instances exist.

import { Queue, Worker } from "bullmq";
import prisma from "@rw/db";
import { bullmqConfig } from "../config.js";
import { materializeShiftInstances } from "../facility/shift/materialize.js";

const SWEEP_QUEUE = "shift-instance-sweep";
const SWEEP_INTERVAL_MS = 5 * 60_000;
// materializeShiftInstances starts 1 day back and adds 1 day internally,
// so lookaheadDays: 1 covers [yesterday, tomorrow] — well past the "now
// + next couple hours" window this sweep must guarantee.
const SWEEP_LOOKAHEAD_DAYS = 1;

const MS_PER_DAY = 86_400_000;

let sweepWorker: Worker | null = null;
let sweepQueue: Queue | null = null;
let onCoverageGapClosed: ((count: number) => void) | null = null;

function bullmqConnection() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return { url, connectTimeout: bullmqConfig.connectTimeout };
}

export interface ShiftInstanceSweepResult {
  /** Number of ShiftInstance rows created (0 if all already existed). */
  created: number;
  /**
   * Number of active assignments that had NO instance covering "now"
   * before the sweep but do after — i.e. production was silently falling
   * back to clock-aligned hours until this sweep materialized them.
   */
  gapsClosed: number;
}

/**
 * Run one sweep: detect coverage gaps, materialize instances for all
 * active assignments, and report any gaps the materialization closed.
 *
 * Exported so it can be invoked directly (tests, one-off backfills).
 */
export async function runShiftInstanceSweep(): Promise<ShiftInstanceSweepResult> {
  const now = new Date();

  const missingBefore = await findAssignmentsWithoutCurrentInstance(now);

  const { created } = await materializeShiftInstances({ lookaheadDays: SWEEP_LOOKAHEAD_DAYS });
  if (created > 0) {
    console.log(`[shift-instance-sweep] Materialized ${created} shift instance(s)`);
  }

  // Re-check only the assignments that were missing coverage. Ones that
  // are covered now were the silent-fallback case; ones still missing
  // simply have no shift scheduled at this time (a legitimate pattern
  // gap, e.g. a single day-shift pattern overnight).
  let gapsClosed = 0;
  if (missingBefore.size > 0) {
    const missingAfter = await findAssignmentsWithoutCurrentInstance(now, [...missingBefore]);
    const closed = [...missingBefore].filter((id) => !missingAfter.has(id));
    gapsClosed = closed.length;
    if (gapsClosed > 0) {
      console.warn(
        `[shift-instance-sweep] ${gapsClosed} active assignment(s) had no ShiftInstance covering now ` +
          `(facts were falling back to clock-aligned hours) — materialized just-in-time: ${closed.join(", ")}`,
      );
      onCoverageGapClosed?.(gapsClosed);
    }
  }

  return { created, gapsClosed };
}

/**
 * Find active assignments (started, not ended) with no ShiftInstance
 * whose [startTime, endTime) window covers `now`.
 */
async function findAssignmentsWithoutCurrentInstance(now: Date, restrictToIds?: string[]): Promise<Set<string>> {
  const today = new Date(Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY);

  const assignments = await prisma.shiftAssignment.findMany({
    where: {
      ...(restrictToIds ? { id: { in: restrictToIds } } : {}),
      rotationStartDate: { lte: now },
      OR: [{ rotationEndDate: null }, { rotationEndDate: { gte: today } }],
    },
    select: { id: true },
  });
  if (assignments.length === 0) return new Set();

  const ids = assignments.map((a) => a.id);
  const covered = await prisma.shiftInstance.findMany({
    where: {
      assignmentId: { in: ids },
      startTime: { lte: now },
      endTime: { gt: now },
    },
    select: { assignmentId: true },
  });

  const coveredIds = new Set(covered.map((i) => i.assignmentId));
  return new Set(ids.filter((id) => !coveredIds.has(id)));
}

/**
 * Start the sweep worker + repeating job scheduler.
 *
 * `onCoverageGapClosed` is invoked with the number of assignments whose
 * missing-coverage gap the sweep just closed — callers can wire it to a
 * metrics counter (prom-client lives in apps/workers, not here).
 */
export async function startShiftInstanceSweep(options?: {
  onCoverageGapClosed?: (count: number) => void;
}): Promise<void> {
  if (sweepWorker) return;

  const connection = bullmqConnection();
  if (!connection) {
    console.log("[shift-instance-sweep] REDIS_URL not set, skipping");
    return;
  }

  onCoverageGapClosed = options?.onCoverageGapClosed ?? null;

  sweepWorker = new Worker(SWEEP_QUEUE, async () => runShiftInstanceSweep(), {
    connection,
    stalledInterval: bullmqConfig.stalledInterval,
    drainDelay: bullmqConfig.drainDelay,
  });

  sweepWorker.on("failed", (job, err) => {
    console.error(`[shift-instance-sweep] Job ${job?.id} failed`, err);
  });

  sweepQueue = new Queue(SWEEP_QUEUE, { connection });
  await sweepQueue.upsertJobScheduler(
    "shift-instance-sweep",
    { every: SWEEP_INTERVAL_MS },
    { name: "shift-instance-sweep", opts: { removeOnComplete: true, removeOnFail: { count: 10 } } },
  );

  console.log(`[shift-instance-sweep] started (every ${SWEEP_INTERVAL_MS / 60_000}m)`);
}

export async function stopShiftInstanceSweep(): Promise<void> {
  await Promise.all([sweepWorker?.close(), sweepQueue?.close()]);
  sweepWorker = null;
  sweepQueue = null;
  onCoverageGapClosed = null;
}
