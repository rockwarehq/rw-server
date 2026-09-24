// ShiftAmendment: correct a shift that is running or has finished (ADR-0015).
//
// The day's rows are regenerated with the amendment as one more rule and
// diffed against what exists: a shift keeps its id and gets its new window,
// gap rows widen, shrink, split or vanish, and anything unmatched is created
// or removed. Facts inside the union of the old and new windows are
// re-stamped by time and period rows are re-cut, all in one transaction.
// Metric buckets are rebuilt from the `amended` event in the rollups worker.

import prisma from "@rw/db";
import type { Prisma, ShiftAmendment } from "@rw/db";
import { publishUiChange } from "../../events/ui-changes.js";
import { dropShiftAlignedBuckets, rebuildStationWindow } from "../../metrics/rebuild-window.js";
import { clearProcessCaches } from "../../metrics/shift.js";
import { cutAtShiftBoundaries, cutJobLog, cutStateEntry, type StationScope } from "../station/periods.js";
import { acquireStationLock } from "../station/state.js";
import { publishShiftHistoryEvent } from "./events.js";
import {
  fillNotScheduledGaps,
  coveringDate,
  findInUseShiftInstanceIds,
  hasOverlappingRows,
  type InstanceRow,
  instanceRowSelect,
  isGapRow,
  MS_PER_DAY,
  type OverrideRule,
  publishShiftInstanceEvents,
  type ShiftScope,
  toRule,
} from "./materialize.js";
import { type CreateShiftOverrideInput, OVERLAP_ERROR, validateRule } from "./override.js";
import { RESTAMPED_TABLES, STAMPED_FACTS } from "./stamped-facts.js";

type Tx = Prisma.TransactionClient;
type Result<T> = { data: T } | { error: string; code: string };

/** An override's input, for a day that has already run. The shift must be named. */
export interface AmendShiftInput extends CreateShiftOverrideInput {
  shiftName: string;
  actorUserId?: string | null;
  /**
   * Take the named added shift off the day again. Only a shift an amendment
   * added can go; a shift the pattern defines is cancelled, never removed.
   * Undo of an "added" amendment is the only caller.
   */
  remove?: boolean;
  /** Set by undo: the amendment this one reverses. Both become history. */
  undoOf?: string | null;
}

type AmendOutcome =
  | { error: string; code: string }
  | { amendment: ShiftAmendment; removed: ExistingRow[]; updated: string[] };

export async function amendShift(input: AmendShiftInput): Promise<Result<ShiftAmendment>> {
  const scope: ShiftScope = { siteId: input.siteId, workCenterId: input.workCenterId ?? null };
  const { shiftName } = input;
  const rule = toRule(input);
  // A day that has run is described by its rows, not by the pattern: the shift
  // is found in the scope itself, since a row outlives the assignment that
  // built it (a schedule published with a past start ends the previous one
  // behind rows that already ran).
  const current = await prisma.shiftInstance.findFirst({
    where: {
      siteId: scope.siteId,
      workCenterId: scope.workCenterId,
      businessDate: rule.businessDate,
      OR: [{ definition: { shiftName } }, { definitionId: null, isScheduled: true, shiftName }],
    },
  });
  const now = new Date();
  if (!current && !input.remove && (!rule.startTime || !rule.endTime)) {
    return { error: "Give the start and end of the shift to add", code: "SHIFT_ADD_NEEDS_TIMES" };
  }
  // A removal carries no replacement window by design; everything else must say
  // what it changes.
  const invalid = input.remove ? null : validateRule(rule);
  if (invalid) return invalid;

  if (current) {
    if (current.startTime > now) {
      return { error: "The shift has not started; change it with an override", code: "SHIFT_NOT_STARTED" };
    }
    if (input.remove && (current.definitionId !== null || !current.isScheduled)) {
      return { error: "Only a shift that was added can be removed; cancel the shift instead", code: "SHIFT_NOT_ADDED" };
    }
  } else {
    // No row of that name: the amendment adds one to a day that has run, which
    // is how production worked outside the schedule gets a shift to hang on.
    if (input.remove) return { error: "No shift with that name on that date", code: "SHIFT_NOT_FOUND" };
    if ((rule.startTime as Date) > now) {
      return { error: "That time has not run yet; add the shift with an override", code: "SHIFT_NOT_STARTED" };
    }
    if (rule.isScheduled === false) {
      return { error: "A shift added to a day that ran is worked time", code: "SHIFT_ADD_NOT_WORKED" };
    }
  }

  // An added shift joins the schedule that owns the time it lands in; that row
  // also names the assignment this amendment locks on and is recorded against.
  const host =
    current ??
    (await prisma.shiftInstance.findFirst({
      where: {
        siteId: scope.siteId,
        workCenterId: scope.workCenterId,
        startTime: { lte: rule.startTime as Date },
        endTime: { gt: rule.startTime as Date },
      },
      orderBy: { startTime: "desc" },
    }));
  if (!host) return { error: "No shift schedule covers that time", code: "SHIFT_NOT_FOUND" };
  const lockKey = host.assignmentId;

  const dateMs = rule.businessDate.getTime();
  const from = new Date(dateMs - MS_PER_DAY);
  const to = new Date(dateMs + 3 * MS_PER_DAY);
  const stations = await scopeStations(scope, rule.businessDate);

  const outcome = await prisma.$transaction(
    async (tx): Promise<AmendOutcome> => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text`;
      for (const id of stations.map((s) => s.id).sort()) await acquireStationLock(tx, id);

      // Scope-wide, not one assignment: a handover day holds rows of both, and
      // the Off Hours rows between them are cut from the union.
      const existing = await tx.shiftInstance.findMany({
        where: {
          siteId: scope.siteId,
          workCenterId: scope.workCenterId,
          endTime: { gt: from },
          startTime: { lt: to },
        },
        select: { id: true, ...instanceRowSelect },
      });
      const change: AmendTarget = current
        ? { kind: input.remove ? "remove" : "change", rowId: current.id }
        : { kind: "add", row: addedRow(host, rule) };
      const target = amendedRows(existing, rule, change);
      if (hasOverlappingRows(target)) return OVERLAP_ERROR;
      const plan = planInstanceDiff(existing, target);
      const window = plan.window;
      if (!window) return { error: "Amendment changes nothing", code: "INVALID_AMENDMENT" };
      const obsoleteIds = plan.obsolete.map((r) => r.id);
      // Only a reference the re-stamp cannot move keeps an obsolete row alive.
      const inUse = await findInUseShiftInstanceIds(obsoleteIds, {
        ignoreBuckets: true,
        ignoreTables: RESTAMPED_TABLES,
        client: tx,
      });
      const removable = plan.obsolete.filter((r) => !inUse.has(r.id));
      // Removed first: a shift moving back over a gap takes the start time that
      // gap row still holds, and the pair may not share it even mid-transaction.
      if (removable.length > 0) {
        await tx.shiftInstance.deleteMany({ where: { id: { in: removable.map((r) => r.id) } } });
      }

      for (const { id, after } of plan.updates) {
        await tx.shiftInstance.update({
          where: { id },
          data: {
            startTime: after.startTime,
            endTime: after.endTime,
            shiftName: after.shiftName,
            isScheduled: after.isScheduled,
          },
        });
      }
      if (plan.creates.length > 0) await tx.shiftInstance.createMany({ data: plan.creates });

      await restampFacts(
        tx,
        scope,
        stations.map((s) => s.id),
        window,
        obsoleteIds,
      );
      for (const station of stations) await recutPeriods(tx, station, window);

      const amendment = await tx.shiftAmendment.create({
        data: {
          siteId: scope.siteId,
          workCenterId: scope.workCenterId,
          assignmentId: lockKey,
          businessDate: rule.businessDate,
          shiftName,
          previousStartTime: current?.startTime ?? null,
          previousEndTime: current?.endTime ?? null,
          previousScheduled: current?.isScheduled ?? null,
          previousName: current?.shiftName ?? null,
          // A removal records the window it took away in `previous` and leaves
          // the replacement empty, so the builder stops re-adding the shift.
          startTime: input.remove ? null : rule.startTime,
          endTime: input.remove ? null : rule.endTime,
          isScheduled: input.remove ? null : rule.isScheduled,
          note: rule.note,
          undoOfId: input.undoOf ?? null,
          windowStart: window.start,
          windowEnd: window.end,
          createdById: input.actorUserId ?? null,
        },
      });
      console.log(
        `[shift-amend] ${amendment.id}: updated ${plan.updates.length}, created ${plan.creates.length}, removed ${removable.length} of ${plan.obsolete.length} obsolete, window ${window.start.toISOString()}→${window.end.toISOString()}`,
      );
      return { amendment, removed: removable, updated: plan.updates.map((u) => u.id) };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  if ("error" in outcome) return outcome;
  clearProcessCaches(); // shift windows resolved before the commit are stale now

  const site = await prisma.site.findUniqueOrThrow({ where: { id: scope.siteId }, select: { workspaceId: true } });
  const eventRow = (id: string) => ({ id, siteId: scope.siteId, site });
  publishShiftInstanceEvents("updated", outcome.updated.map(eventRow));
  publishShiftInstanceEvents(
    "deleted",
    outcome.removed.map((r) => eventRow(r.id)),
  );
  publishShiftHistoryEvent({
    action: "amended",
    workspaceId: site.workspaceId,
    siteId: scope.siteId,
    workCenterId: scope.workCenterId,
    amendmentId: outcome.amendment.id,
    businessDate: rule.businessDate.toISOString().slice(0, 10),
    shiftName,
    windowStart: outcome.amendment.windowStart.toISOString(),
    windowEnd: outcome.amendment.windowEnd.toISOString(),
  });
  return { data: outcome.amendment };
}

/**
 * Undo = a new amendment that restores the window the amended one replaced,
 * naming it in `undoOfId` so neither reads as in force afterwards. An amendment
 * that added a shift has no previous window, so its undo takes the shift off
 * the day again. Only a correction can be undone: to put an undone change back,
 * make it again.
 */
export async function undoShiftAmendment(id: string, actorUserId?: string | null): Promise<Result<ShiftAmendment>> {
  const a = await prisma.shiftAmendment.findUnique({ where: { id } });
  if (!a) return { error: "Shift amendment not found", code: "SHIFT_AMENDMENT_NOT_FOUND" };
  if (a.undoOfId) return { error: "That change has already been undone", code: "SHIFT_AMENDMENT_UNDONE" };
  const undone = await prisma.shiftAmendment.findFirst({ where: { undoOfId: id }, select: { id: true } });
  if (undone) return { error: "That change has already been undone", code: "SHIFT_AMENDMENT_UNDONE" };

  const common = {
    siteId: a.siteId,
    workCenterId: a.workCenterId,
    businessDate: a.businessDate,
    shiftName: a.shiftName,
    undoOf: a.id,
    actorUserId,
  };
  if (a.previousStartTime === null) return amendShift({ ...common, remove: true });
  return amendShift({
    ...common,
    startTime: a.previousStartTime,
    endTime: a.previousEndTime,
    isScheduled: a.previousScheduled,
    note: null,
  });
}

export async function getById(id: string) {
  const amendment = await prisma.shiftAmendment.findUnique({ where: { id } });
  return amendment ? { data: amendment } : null;
}

export async function listShiftAmendments(filter: {
  siteId: string;
  workCenterId?: string | null;
  from?: Date;
  to?: Date;
}) {
  return prisma.shiftAmendment.findMany({
    where: {
      siteId: filter.siteId,
      workCenterId: filter.workCenterId,
      businessDate: { gte: filter.from, lte: filter.to },
    },
    orderBy: { createdAt: "desc" },
  });
}

/** Re-publish the amended event so the rebuild consumer picks the amendment up again. */
export async function retryShiftAmendment(id: string): Promise<Result<{ amendmentId: string }>> {
  const a = await prisma.shiftAmendment.findUnique({
    where: { id },
    include: { site: { select: { workspaceId: true } } },
  });
  if (!a) return { error: "Shift amendment not found", code: "SHIFT_AMENDMENT_NOT_FOUND" };
  await prisma.shiftAmendment.update({ where: { id }, data: { status: "PENDING_REBUILD", rebuildError: null } });
  publishShiftHistoryEvent({
    action: "amended",
    workspaceId: a.site.workspaceId,
    siteId: a.siteId,
    workCenterId: a.workCenterId,
    amendmentId: a.id,
    businessDate: a.businessDate.toISOString().slice(0, 10),
    shiftName: a.shiftName,
    windowStart: a.windowStart.toISOString(),
    windowEnd: a.windowEnd.toISOString(),
  });
  return { data: { amendmentId: a.id } };
}

// ── Target rows ──────────────────────────────────────────────────

/** What the amendment does to the day: retime/cancel one row, drop one, or add one. */
export type AmendTarget =
  | { kind: "change"; rowId: string }
  | { kind: "remove"; rowId: string }
  | { kind: "add"; row: InstanceRow };

/**
 * The scope's rows with the amendment applied and the Off Hours rows re-cut
 * around the result. The existing rows are the starting point, so an amendment
 * never re-derives a day that has run from the pattern.
 */
export function amendedRows(existing: ExistingRow[], rule: OverrideRule, target: AmendTarget): InstanceRow[] {
  const shifts = existing
    .filter((r) => !isGapRow(r))
    .flatMap(({ id, ...row }) => {
      if (target.kind === "add" || id !== target.rowId) return [row];
      if (target.kind === "remove") return [];
      return [
        {
          ...row,
          startTime: rule.startTime ?? row.startTime,
          endTime: rule.endTime ?? row.endTime,
          isScheduled: rule.isScheduled ?? row.isScheduled,
        },
      ];
    });
  if (target.kind === "add") shifts.push(target.row);
  // A shift that shrank (or went) gives its time back to Off Hours even when it
  // was the last row of the window, so nothing is left without a stamp.
  const before = target.kind === "add" ? undefined : existing.find((r) => r.id === target.rowId);
  return fillNotScheduledGaps(shifts, before?.endTime);
}

/**
 * The row an "add" writes: no definition, because the pattern never described
 * it, on the schedule that owns the time it lands in.
 */
function addedRow(
  host: { assignmentId: string; siteId: string; workCenterId: string | null },
  rule: OverrideRule,
): InstanceRow {
  return {
    assignmentId: host.assignmentId,
    definitionId: null,
    siteId: host.siteId,
    workCenterId: host.workCenterId,
    shiftName: rule.shiftName as string,
    businessDate: rule.businessDate,
    startTime: rule.startTime as Date,
    endTime: rule.endTime as Date,
    isScheduled: true,
  };
}

// ── Diff planner ─────────────────────────────────────────────────

export type ExistingRow = InstanceRow & { id: string };

export interface InstanceDiff {
  updates: Array<{ id: string; before: ExistingRow; after: InstanceRow }>;
  creates: InstanceRow[];
  /** Unmatched existing rows that overlap something that changed. */
  obsolete: ExistingRow[];
  /**
   * Every changed row's old and new position together: what the re-stamp
   * re-resolves and the metric rebuild recomputes, since a shift bucket sums
   * all of its hours, not just the ones that moved. Null when nothing changed.
   */
  window: { start: Date; end: Date } | null;
}

const overlaps = (a: { startTime: Date; endTime: Date }, b: { startTime: Date; endTime: Date }) =>
  a.startTime < b.endTime && b.startTime < a.endTime;

const sameWindow = (a: InstanceRow, b: InstanceRow) =>
  a.startTime.getTime() === b.startTime.getTime() &&
  a.endTime.getTime() === b.endTime.getTime() &&
  a.shiftName === b.shiftName &&
  a.isScheduled === b.isScheduled;

/** Identity of a shift row across a rebuild: its definition, or its name for an added shift. Gaps have none. */
const identity = (r: InstanceRow) =>
  r.definitionId
    ? `d|${r.definitionId}|${r.businessDate.getTime()}`
    : r.isScheduled
      ? `a|${r.shiftName}|${r.businessDate.getTime()}`
      : null;

/**
 * Match target rows to existing ones — shifts by identity, gaps by overlap —
 * and return what to update, create and remove. Existing rows at the edges
 * that nothing changed touches are left alone.
 */
export function planInstanceDiff(existing: ExistingRow[], target: InstanceRow[]): InstanceDiff {
  const unused = new Set(existing);
  const byIdentity = new Map(existing.flatMap((r) => (identity(r) ? [[identity(r), r] as const] : [])));
  const updates: InstanceDiff["updates"] = [];
  const creates: InstanceRow[] = [];

  // Shifts first so gaps only match leftover gap rows.
  const ordered = [...target.filter((r) => !isGapRow(r)), ...target.filter(isGapRow)];
  for (const after of ordered) {
    const id = identity(after);
    let match = id ? byIdentity.get(id) : undefined;
    if (!id) {
      match = [...unused]
        .filter((r) => isGapRow(r) && overlaps(r, after))
        .sort((a, b) => overlapMs(b, after) - overlapMs(a, after))[0];
    }
    if (match && unused.has(match)) {
      unused.delete(match);
      if (!sameWindow(match, after)) updates.push({ id: match.id, before: match, after });
    } else {
      creates.push(after);
    }
  }

  const changed = [...updates.flatMap((u) => [u.before, u.after]), ...creates];
  const obsolete = [...unused].filter((r) => changed.some((c) => overlaps(r, c)));
  const touched = [...changed, ...obsolete];
  const window =
    touched.length === 0
      ? null
      : {
          start: new Date(Math.min(...touched.map((r) => r.startTime.getTime()))),
          end: new Date(Math.max(...touched.map((r) => r.endTime.getTime()))),
        };
  return { updates, creates, obsolete, window };
}
const overlapMs = (a: { startTime: Date; endTime: Date }, b: { startTime: Date; endTime: Date }) =>
  Math.min(a.endTime.getTime(), b.endTime.getTime()) - Math.max(a.startTime.getTime(), b.startTime.getTime());

// ── Scope, re-stamp, re-cut ──────────────────────────────────────

/** Stations that resolve their shift from this scope: the workcenter's, or every station without its own workcenter schedule. */
async function scopeStations(scope: ShiftScope, businessDate: Date): Promise<StationScope[]> {
  const select = { id: true, siteId: true, workcenterId: true };
  if (scope.workCenterId) {
    return prisma.station.findMany({ where: { workcenterId: scope.workCenterId, deletedAt: null }, select });
  }
  const own = await prisma.shiftAssignment.findMany({
    where: { siteId: scope.siteId, workCenterId: { not: null }, ...coveringDate(businessDate) },
    select: { workCenterId: true },
  });
  const ownIds = own.map((a) => a.workCenterId as string);
  return prisma.station.findMany({
    where: { siteId: scope.siteId, deletedAt: null, OR: [{ workcenterId: null }, { workcenterId: { notIn: ownIds } }] },
    select,
  });
}

/** Re-resolve the stamp of every fact inside the window from the scope's (now updated) instance rows. */
async function restampFacts(
  tx: Tx,
  scope: ShiftScope,
  stationIds: string[],
  window: { start: Date; end: Date },
  obsoleteIds: string[],
) {
  for (const f of STAMPED_FACTS) {
    // Site-level tables belong to the site schedule only.
    if (!f.byStation && scope.workCenterId) continue;
    if (f.byStation && stationIds.length === 0) continue;
    const at = f.at.replace(/"(\w+)"/g, 'f."$1"');
    // Numbered per statement: a parameter the SQL never mentions has no type
    // for Postgres to infer, and the whole statement is rejected.
    const [site, wc, obsolete] = f.byStation ? ["$4", "$5", "$6"] : ["$3", "$4", "$5"];
    const params = f.byStation
      ? [window.start, window.end, stationIds, scope.siteId, scope.workCenterId, obsoleteIds]
      : [window.start, window.end, scope.siteId, scope.workCenterId, obsoleteIds];
    await tx.$executeRawUnsafe(
      `UPDATE "${f.table}" f
       SET "shiftInstanceId" = si.id, "isScheduled" = si."isScheduled"${f.businessDate ? ', "businessDate" = si."businessDate"' : ""}
       FROM "ShiftInstance" si
       WHERE ${at} >= $1 AND ${at} < $2
         AND ${f.byStation ? 'f."stationId" = ANY($3::uuid[])' : `f."siteId" = ${site}::uuid`}${f.where ? ` AND ${f.where}` : ""}
         AND si."siteId" = ${site}::uuid AND si."workCenterId" IS NOT DISTINCT FROM ${wc}::uuid
         AND si.id <> ALL(${obsolete}::uuid[])
         AND si."startTime" <= ${at} AND si."endTime" > ${at}`,
      ...params,
    );
  }
}

/** Period rows crossing a moved boundary are cut there (ADR-0014); their stamps were just re-resolved by start. */
async function recutPeriods(tx: Tx, station: StationScope, window: { start: Date; end: Date }) {
  const now = new Date();
  const span = {
    stationId: station.id,
    startTime: { lt: window.end },
    OR: [{ endTime: { gt: window.start } }, { endTime: null }],
  };
  const [stateRows, jobRows] = await Promise.all([
    tx.stationStateLog.findMany({ where: { ...span, deletedAt: null } }),
    tx.stationJobLog.findMany({ where: span }),
  ]);
  for (const row of stateRows) await cutAtShiftBoundaries(tx, station, row, now, cutStateEntry(tx));
  for (const row of jobRows) await cutAtShiftBoundaries(tx, station, row, now, cutJobLog(tx, station));
}

// ── Metric rebuild (rollups worker) ──────────────────────────────

/**
 * Hour and shift buckets are aligned to shift starts, so the ones inside the
 * window are dropped and rebuilt against the new boundaries for every station
 * in scope, then rolled up. Idempotent — an APPLIED amendment is a no-op.
 */
export async function rebuildForShiftAmendment(amendmentId: string): Promise<void> {
  const a = await prisma.shiftAmendment.findUnique({ where: { id: amendmentId } });
  if (!a || a.status === "APPLIED") return;
  const scope: ShiftScope = { siteId: a.siteId, workCenterId: a.workCenterId };
  const window = { start: a.windowStart, end: a.windowEnd };
  const t0 = Date.now();
  try {
    clearProcessCaches(); // this worker may hold the pre-amendment shift windows
    const stations = await scopeStations(scope, a.businessDate);
    // Every rollup above the stations is re-summed from them, so the scope's own
    // buckets and the site's both go: a boundary that moved would otherwise leave
    // the old site bucket beside the new one, counting the window twice.
    const rollupEntities = [...new Set([scope.workCenterId ?? scope.siteId, scope.siteId])];
    await dropShiftAlignedBuckets(scope.siteId, rollupEntities, window);
    for (const station of stations) {
      const jobs = await prisma.stationJobLog.findMany({
        where: {
          stationId: station.id,
          startTime: { lt: window.end },
          OR: [{ endTime: { gt: window.start } }, { endTime: null }],
        },
        select: { jobId: true },
        distinct: ["jobId"],
      });
      await rebuildStationWindow(station.id, scope.siteId, window, {
        jobIds: jobs.map((j) => j.jobId),
        realignBuckets: true,
      });
    }
    await prisma.shiftAmendment.update({
      where: { id: amendmentId },
      data: { status: "APPLIED", rebuiltAt: new Date(), rebuildError: null },
    });
    console.log(`[shift-amend] rebuilt ${amendmentId}: ${stations.length} station(s) in ${Date.now() - t0}ms`);
    publishUiChange({ kind: "shift-history.rebuilt", siteId: scope.siteId, amendmentId, status: "APPLIED" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.shiftAmendment.update({
      where: { id: amendmentId },
      data: { status: "FAILED", rebuildError: message },
    });
    publishUiChange({ kind: "shift-history.rebuilt", siteId: scope.siteId, amendmentId, status: "FAILED" });
    throw err;
  }
}
