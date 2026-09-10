import type { Prisma } from "@rw/db";
import { resolveShiftStamp } from "../work-context.js";
import { createStationJobLog } from "./jobs.js";

// Rewrites a station's StationJobLog timeline so [from, to) holds exactly one
// job (or none). The planner is pure: it turns the rows touching the window
// into the pieces that survive outside it plus the asserted piece, merges
// touching pieces of the same job, and diffs that against the input rows.

export interface JobLogRow {
  id: string;
  jobId: string;
  jobVersionId: string;
  startTime: Date;
  endTime: Date | null;
}

export interface TimelineTarget {
  jobId: string;
  jobVersionId: string;
}

export interface TimelinePlan<R extends JobLogRow> {
  updates: Array<{ id: string; startTime: Date; endTime: Date | null }>;
  /** copyOf = the tail of a row that straddled the window; null = the asserted job. */
  inserts: Array<{ jobId: string; jobVersionId: string; startTime: Date; endTime: Date | null; copyOf: R | null }>;
  deletes: string[];
}

interface Piece<R> {
  jobId: string;
  jobVersionId: string;
  startTime: Date;
  endTime: Date | null;
  source: R | null;
}

const ms = (d: Date | null) => (d ? d.getTime() : Number.POSITIVE_INFINITY);

export function planTimelineRewrite<R extends JobLogRow>(
  rows: R[],
  from: Date,
  to: Date | null,
  target: TimelineTarget | null,
): TimelinePlan<R> {
  const pieces: Piece<R>[] = [];
  let targetSource: R | null = null;
  for (const r of rows) {
    const start = r.startTime.getTime();
    const end = ms(r.endTime);
    const inWindow = start < ms(to) && end > from.getTime();
    if (target && !targetSource && inWindow && r.jobId === target.jobId && r.jobVersionId === target.jobVersionId) {
      targetSource = r;
    }
    if (start < from.getTime()) {
      pieces.push({
        ...jobOf(r),
        startTime: r.startTime,
        endTime: end <= from.getTime() ? r.endTime : from,
        source: r,
      });
    }
    if (to && end > to.getTime()) {
      pieces.push({ ...jobOf(r), startTime: start >= to.getTime() ? r.startTime : to, endTime: r.endTime, source: r });
    }
  }
  if (target) pieces.push({ ...target, startTime: from, endTime: to, source: targetSource });
  pieces.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  const merged: Piece<R>[] = [];
  for (const p of pieces) {
    const last = merged.at(-1);
    if (
      last?.endTime &&
      last.endTime.getTime() === p.startTime.getTime() &&
      last.jobId === p.jobId &&
      last.jobVersionId === p.jobVersionId
    ) {
      last.endTime = p.endTime;
      last.source ??= p.source;
    } else {
      merged.push({ ...p });
    }
  }

  const plan: TimelinePlan<R> = { updates: [], inserts: [], deletes: [] };
  const kept = new Set<string>();
  for (const p of merged) {
    if (p.source && !kept.has(p.source.id)) {
      kept.add(p.source.id);
      if (ms(p.startTime) !== ms(p.source.startTime) || ms(p.endTime) !== ms(p.source.endTime)) {
        plan.updates.push({ id: p.source.id, startTime: p.startTime, endTime: p.endTime });
      }
    } else {
      plan.inserts.push({ ...jobOf(p), startTime: p.startTime, endTime: p.endTime, copyOf: p.source });
    }
  }
  plan.deletes = rows.filter((r) => !kept.has(r.id)).map((r) => r.id);
  return plan;
}

const jobOf = (x: { jobId: string; jobVersionId: string }) => ({ jobId: x.jobId, jobVersionId: x.jobVersionId });

/** Rows touching [from, to]: overlapping ones plus the neighbours that end at `from` or start at `to`. */
export async function loadTimelineRows(tx: Prisma.TransactionClient, stationId: string, from: Date, to: Date | null) {
  return tx.stationJobLog.findMany({
    where: {
      stationId,
      ...(to ? { startTime: { lte: to } } : {}),
      OR: [{ endTime: { gte: from } }, { endTime: null }],
    },
    orderBy: { startTime: "asc" },
  });
}

/** Apply a plan under the station lock. Rows re-resolve their shift stamp at their (new) startTime. */
export async function applyTimelinePlan(
  tx: Prisma.TransactionClient,
  station: { id: string; siteId: string; workcenterId: string | null },
  plan: TimelinePlan<{
    id: string;
    jobId: string;
    jobVersionId: string;
    startTime: Date;
    endTime: Date | null;
    standardCycle: Prisma.Decimal | null;
    standardQuantity: Prisma.Decimal | null;
    quantityUnit: string;
  }>,
  targetStandards: { standardCycle: number | null; standardQuantity: number | null; quantityUnit: string },
) {
  if (plan.deletes.length > 0) await tx.stationJobLog.deleteMany({ where: { id: { in: plan.deletes } } });
  for (const u of plan.updates) {
    const stamp = await resolveShiftStamp(station.siteId, station.workcenterId, u.startTime, tx);
    await tx.stationJobLog.update({ where: { id: u.id }, data: { ...u, ...stamp, lastAccumulatedAt: null } });
  }
  for (const i of plan.inserts) {
    const std = i.copyOf
      ? {
          standardCycle: i.copyOf.standardCycle?.toNumber() ?? null,
          standardQuantity: i.copyOf.standardQuantity?.toNumber() ?? null,
          quantityUnit: i.copyOf.quantityUnit,
        }
      : targetStandards;
    await createStationJobLog(tx, station, { ...jobOf(i), startTime: i.startTime, endTime: i.endTime, ...std });
  }
}
