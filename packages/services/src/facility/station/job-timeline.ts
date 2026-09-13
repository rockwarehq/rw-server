import { randomUUID } from "node:crypto";
import type { Prisma, StationJobLog } from "@rw/db";
import { resolveShiftStamp } from "../work-context.js";
import { createStationJobLog } from "./jobs.js";
import { cutAtShiftBoundaries, cutJobLog } from "./periods.js";

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
  /** Rows are per-shift pieces; touching pieces only merge within one shift. */
  shiftInstanceId?: string | null;
}

export interface TimelineTarget {
  jobId: string;
  jobVersionId: string;
}

export interface TimelinePlan<R extends JobLogRow> {
  /** asserted = the row absorbed the asserted piece (same job, touching), so it is part of the amendment. */
  updates: Array<{ id: string; startTime: Date; endTime: Date | null; asserted?: boolean }>;
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
  asserted?: boolean;
}

const sameShift = (a: { shiftInstanceId?: string | null }, b: { shiftInstanceId?: string | null }) =>
  a.shiftInstanceId === undefined || b.shiftInstanceId === undefined || a.shiftInstanceId === b.shiftInstanceId;

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
  if (target) pieces.push({ ...target, startTime: from, endTime: to, source: targetSource, asserted: true });
  pieces.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  const merged: Piece<R>[] = [];
  for (const p of pieces) {
    const last = merged.at(-1);
    if (
      last?.endTime &&
      last.endTime.getTime() === p.startTime.getTime() &&
      last.jobId === p.jobId &&
      last.jobVersionId === p.jobVersionId &&
      sameShift(last.source ?? {}, p.source ?? {})
    ) {
      last.endTime = p.endTime;
      last.source ??= p.source;
      last.asserted ||= p.asserted;
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
        plan.updates.push({
          id: p.source.id,
          startTime: p.startTime,
          endTime: p.endTime,
          ...(p.asserted ? { asserted: true } : {}),
        });
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

/**
 * Apply a plan under the station lock. Rows re-resolve their shift stamp at
 * their (new) startTime, and every row touching the window is then cut at
 * the shift boundaries it spans. A blockId is one contiguous run: the asserted
 * piece continues a touching run of the same job (so per-shift amendments
 * stitch together), and a run the window carved in two gets a new blockId
 * for its remainder.
 */
export async function applyTimelinePlan(
  tx: Prisma.TransactionClient,
  station: { id: string; siteId: string; workcenterId: string | null },
  plan: TimelinePlan<StationJobLog>,
  window: { from: Date; toEff: Date },
  targetStandards: {
    standardCycle: number | null;
    standardQuantity: number | null;
    quantityUnit: string;
    /** Stamped on the asserted pieces only; carved remainders keep their history. */
    amendmentId?: string;
  },
) {
  if (plan.deletes.length > 0) await tx.stationJobLog.deleteMany({ where: { id: { in: plan.deletes } } });
  for (const { asserted, ...u } of plan.updates) {
    const stamp = await resolveShiftStamp(station.siteId, station.workcenterId, u.startTime, tx);
    const amendmentId = asserted ? targetStandards.amendmentId : undefined;
    await tx.stationJobLog.update({ where: { id: u.id }, data: { ...u, ...stamp, lastAccumulatedAt: null, amendmentId } });
  }
  for (const i of plan.inserts) {
    const std = i.copyOf
      ? {
          blockId: i.copyOf.blockId,
          standardCycle: i.copyOf.standardCycle?.toNumber() ?? null,
          standardQuantity: i.copyOf.standardQuantity?.toNumber() ?? null,
          quantityUnit: i.copyOf.quantityUnit,
        }
      : { ...targetStandards, blockId: await joinBlockId(tx, station.id, i) };
    await createStationJobLog(tx, station, { ...jobOf(i), startTime: i.startTime, endTime: i.endTime, ...std });
  }
  const touched = await tx.stationJobLog.findMany({
    where: {
      stationId: station.id,
      startTime: { lt: window.toEff },
      OR: [{ endTime: { gt: window.from } }, { endTime: null }],
    },
  });
  for (const row of touched) await cutAtShiftBoundaries(tx, station, row, window.toEff, cutJobLog(tx, station));
  await splitBrokenBlocks(tx, station.id, window);
}

/** The block of a same-job piece ending at the start (or starting at the end); both sides become one run. */
async function joinBlockId(
  tx: Prisma.TransactionClient,
  stationId: string,
  piece: { jobId: string; jobVersionId: string; startTime: Date; endTime: Date | null },
): Promise<string> {
  const run = { stationId, jobId: piece.jobId, jobVersionId: piece.jobVersionId };
  const left = await tx.stationJobLog.findFirst({
    where: { ...run, endTime: piece.startTime },
    select: { blockId: true },
  });
  const right = piece.endTime
    ? await tx.stationJobLog.findFirst({ where: { ...run, startTime: piece.endTime }, select: { blockId: true } })
    : null;
  const blockId = left?.blockId ?? right?.blockId ?? randomUUID();
  if (right && right.blockId !== blockId) {
    await tx.stationJobLog.updateMany({ where: { stationId, blockId: right.blockId }, data: { blockId } });
  }
  return blockId;
}

/** Blocks with pieces on both sides of the window but none inside it: the part after the window is a new run. */
async function splitBrokenBlocks(tx: Prisma.TransactionClient, stationId: string, window: { from: Date; toEff: Date }) {
  await tx.$executeRaw`
    WITH broken AS (
      SELECT "blockId", gen_random_uuid()::text AS "newId"
      FROM "StationJobLog"
      WHERE "stationId" = ${stationId}::uuid
      GROUP BY "blockId"
      HAVING bool_or("startTime" < ${window.from})
         AND bool_or("startTime" >= ${window.toEff})
         AND NOT bool_or("startTime" < ${window.toEff} AND COALESCE("endTime", 'infinity'::timestamptz) > ${window.from})
    )
    UPDATE "StationJobLog" l SET "blockId" = b."newId"
    FROM broken b
    WHERE l."stationId" = ${stationId}::uuid AND l."blockId" = b."blockId" AND l."startTime" >= ${window.toEff}
  `;
}
