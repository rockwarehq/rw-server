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
import { getSiteTimezone } from "../../metrics/bucket.js";
import { dropShiftAlignedBuckets, rebuildStationWindow } from "../../metrics/rebuild-window.js";
import { cutAtShiftBoundaries, cutJobLog, cutStateEntry, type StationScope } from "../station/periods.js";
import { acquireStationLock } from "../station/state.js";
import { publishShiftHistoryEvent } from "./events.js";
import {
  assignmentsCovering,
  buildInstanceRows,
  findInUseShiftInstanceIds,
  floorToDay,
  type InstanceRow,
  isGapRow,
  loadOverrides,
  MS_PER_DAY,
  type OverrideRule,
  publishShiftInstanceEvents,
  ruleKey,
} from "./materialize.js";
import { overlapError, validateRule } from "./override.js";

type Tx = Prisma.TransactionClient;
type Scope = { siteId: string; workCenterId: string | null };
type Result<T> = { data: T } | { error: string; code: string };

export interface AmendShiftInput {
  siteId: string;
  workCenterId?: string | null;
  businessDate: Date;
  shiftName: string;
  startTime?: Date | null;
  endTime?: Date | null;
  /** null = as defined; false = not worked (named by `label`); true = worked. */
  isScheduled?: boolean | null;
  label?: string | null;
  actorUserId?: string | null;
}

type AmendOutcome =
  | { error: string; code: string }
  | { amendment: ShiftAmendment; removed: ExistingRow[]; updated: string[] };

export async function amendShift(input: AmendShiftInput): Promise<Result<ShiftAmendment>> {
  const scope: Scope = { siteId: input.siteId, workCenterId: input.workCenterId ?? null };
  const { shiftName } = input;
  const rule: OverrideRule = {
    businessDate: floorToDay(input.businessDate),
    shiftName,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    isScheduled: input.isScheduled ?? null,
    label: input.label ?? null,
  };
  const invalid = validateRule(rule);
  if (invalid) return invalid;

  const assignments = await assignmentsCovering(scope.siteId, scope.workCenterId, rule.businessDate);
  const current = await prisma.shiftInstance.findFirst({
    where: {
      assignmentId: { in: assignments.map((a) => a.id) },
      businessDate: rule.businessDate,
      OR: [{ definition: { shiftName } }, { definitionId: null, isScheduled: true, shiftName }],
    },
  });
  if (!current) return { error: "No shift with that name on that date", code: "SHIFT_NOT_FOUND" };
  if (current.startTime > new Date()) {
    return { error: "The shift has not started; change it with an override", code: "SHIFT_NOT_STARTED" };
  }
  const assignment = assignments.find((a) => a.id === current.assignmentId);
  if (!assignment) return { error: "Shift assignment not found", code: "SHIFT_ASSIGNMENT_NOT_FOUND" };

  const overlap = await overlapError(scope, rule, [assignment]);
  if (overlap) return overlap;

  const timezone = await getSiteTimezone(scope.siteId);
  const dateMs = rule.businessDate.getTime();
  const rules = (await loadOverrides(scope, dateMs - MS_PER_DAY, dateMs + 3 * MS_PER_DAY)).filter(
    (r) => ruleKey(r) !== ruleKey(rule),
  );
  const target = buildInstanceRows(assignment, dateMs - MS_PER_DAY, 2, [], timezone, [...rules, rule]);
  const stations = await scopeStations(scope, rule.businessDate);

  const outcome = await prisma.$transaction(
    async (tx): Promise<AmendOutcome> => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${assignment.id}))::text`;
      for (const station of stations) await acquireStationLock(tx, station.id);

      const existing = await tx.shiftInstance.findMany({
        where: {
          assignmentId: assignment.id,
          endTime: { gt: new Date(dateMs - MS_PER_DAY) },
          startTime: { lt: new Date(dateMs + 3 * MS_PER_DAY) },
        },
      });
      const plan = planInstanceDiff(existing, target);
      if (plan.updates.length + plan.creates.length + plan.obsolete.length === 0) {
        return { error: "Amendment changes nothing", code: "INVALID_AMENDMENT" };
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

      const window = plan.window as { start: Date; end: Date };
      await restampFacts(
        tx,
        scope,
        stations.map((s) => s.id),
        window,
        plan.obsolete.map((r) => r.id),
      );
      // Obsolete rows go before the re-cut, so the cutter cannot resolve onto them.
      const inUse = await findInUseShiftInstanceIds(
        plan.obsolete.map((r) => r.id),
        { ignoreBuckets: true, client: tx },
      );
      const removable = plan.obsolete.filter((r) => !inUse.has(r.id));
      if (removable.length > 0) {
        await tx.shiftInstance.deleteMany({ where: { id: { in: removable.map((r) => r.id) } } });
      }
      for (const station of stations) await recutPeriods(tx, station, window);

      const amendment = await tx.shiftAmendment.create({
        data: {
          siteId: scope.siteId,
          workCenterId: scope.workCenterId,
          assignmentId: assignment.id,
          businessDate: rule.businessDate,
          shiftName,
          previousStartTime: current.startTime,
          previousEndTime: current.endTime,
          previousScheduled: current.isScheduled,
          previousName: current.shiftName,
          startTime: rule.startTime,
          endTime: rule.endTime,
          isScheduled: rule.isScheduled,
          label: rule.label,
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

/** Undo = a new amendment that restores the window the amended one replaced. */
export async function undoShiftAmendment(id: string, actorUserId?: string | null): Promise<Result<ShiftAmendment>> {
  const a = await prisma.shiftAmendment.findUnique({ where: { id } });
  if (!a) return { error: "Shift amendment not found", code: "SHIFT_AMENDMENT_NOT_FOUND" };
  return amendShift({
    siteId: a.siteId,
    workCenterId: a.workCenterId,
    businessDate: a.businessDate,
    shiftName: a.shiftName,
    startTime: a.previousStartTime,
    endTime: a.previousEndTime,
    isScheduled: a.previousScheduled,
    label: a.previousScheduled ? null : a.previousName,
    actorUserId,
  });
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

// ── Diff planner ─────────────────────────────────────────────────

export type ExistingRow = InstanceRow & { id: string };

export interface InstanceDiff {
  updates: Array<{ id: string; before: ExistingRow; after: InstanceRow }>;
  creates: InstanceRow[];
  /** Unmatched existing rows that overlap something that changed. */
  obsolete: ExistingRow[];
  /** Union of every changed window; null when nothing changed. */
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
  // Only the time that actually moved: each edge of an update between its old
  // and new position, plus whole created and obsolete rows. A change that
  // moves nothing (cancel: flag and name only) keeps the row's own window.
  const segments = [
    ...updates.flatMap(({ before, after }) => [
      { startTime: minDate(before.startTime, after.startTime), endTime: maxDate(before.startTime, after.startTime) },
      { startTime: minDate(before.endTime, after.endTime), endTime: maxDate(before.endTime, after.endTime) },
    ]),
    ...creates,
    ...obsolete,
  ].filter((seg) => seg.startTime < seg.endTime);
  const span = segments.length > 0 ? segments : updates.map((u) => u.after);
  const window =
    span.length === 0
      ? null
      : {
          start: new Date(Math.min(...span.map((r) => r.startTime.getTime()))),
          end: new Date(Math.max(...span.map((r) => r.endTime.getTime()))),
        };
  return { updates, creates, obsolete, window };
}

const minDate = (a: Date, b: Date) => (a < b ? a : b);
const maxDate = (a: Date, b: Date) => (a < b ? b : a);
const overlapMs = (a: { startTime: Date; endTime: Date }, b: { startTime: Date; endTime: Date }) =>
  Math.min(a.endTime.getTime(), b.endTime.getTime()) - Math.max(a.startTime.getTime(), b.startTime.getTime());

// ── Scope, re-stamp, re-cut ──────────────────────────────────────

/** Stations that resolve their shift from this scope: the workcenter's, or every station without its own workcenter schedule. */
async function scopeStations(scope: Scope, businessDate: Date): Promise<StationScope[]> {
  const select = { id: true, siteId: true, workcenterId: true };
  if (scope.workCenterId) {
    return prisma.station.findMany({ where: { workcenterId: scope.workCenterId, deletedAt: null }, select });
  }
  const own = await prisma.shiftAssignment.findMany({
    where: {
      siteId: scope.siteId,
      workCenterId: { not: null },
      rotationStartDate: { lte: new Date(businessDate.getTime() + 2 * MS_PER_DAY) },
      OR: [{ rotationEndDate: null }, { rotationEndDate: { gte: new Date(businessDate.getTime() - 2 * MS_PER_DAY) } }],
    },
    select: { workCenterId: true },
  });
  const ownIds = own.map((a) => a.workCenterId as string);
  return prisma.station.findMany({
    where: { siteId: scope.siteId, deletedAt: null, OR: [{ workcenterId: null }, { workcenterId: { notIn: ownIds } }] },
    select,
  });
}

/** Every shift-stamped fact table, the instant it is stamped by, and whether it is per station. */
const STAMPED_FACTS = [
  { table: "Cycle", at: 'COALESCE("end", "start")', byStation: true, businessDate: true },
  { table: "InventoryItem", at: '"createdAt"', byStation: true, businessDate: true },
  { table: "ItemDispositionLog", at: '"createdAt"', byStation: true, businessDate: true },
  { table: "Call", at: '"openedAt"', byStation: true, businessDate: true },
  { table: "StationModeLog", at: '"startTime"', byStation: true, businessDate: false },
  { table: "StationLogonSession", at: '"logonTime"', byStation: true, businessDate: true },
  { table: "StationStateLog", at: '"startTime"', byStation: true, businessDate: true },
  { table: "StationJobLog", at: '"startTime"', byStation: true, businessDate: true },
  { table: "MaterialLedgerEntry", at: '"createdAt"', byStation: false, businessDate: true },
  { table: "OrderConsumption", at: '"createdAt"', byStation: false, businessDate: true },
  { table: "ProductStockAdjustment", at: '"createdAt"', byStation: false, businessDate: true },
] as const;

/** Re-resolve the stamp of every fact inside the window from the scope's (now updated) instance rows. */
async function restampFacts(
  tx: Tx,
  scope: Scope,
  stationIds: string[],
  window: { start: Date; end: Date },
  obsoleteIds: string[],
) {
  for (const f of STAMPED_FACTS) {
    // Site-level tables belong to the site schedule only.
    if (!f.byStation && scope.workCenterId) continue;
    if (f.byStation && stationIds.length === 0) continue;
    const at = f.at.replace(/"(\w+)"/g, 'f."$1"');
    await tx.$executeRawUnsafe(
      `UPDATE "${f.table}" f
       SET "shiftInstanceId" = si.id${f.businessDate ? ', "businessDate" = si."businessDate"' : ""}
       FROM "ShiftInstance" si
       WHERE ${at} >= $1 AND ${at} < $2
         AND ${f.byStation ? 'f."stationId" = ANY($3::uuid[])' : 'f."siteId" = $4::uuid'}
         AND si."siteId" = $4::uuid AND si."workCenterId" IS NOT DISTINCT FROM $5::uuid
         AND si.id <> ALL($6::uuid[])
         AND si."startTime" <= ${at} AND si."endTime" > ${at}`,
      window.start,
      window.end,
      stationIds,
      scope.siteId,
      scope.workCenterId,
      obsoleteIds,
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
  const scope: Scope = { siteId: a.siteId, workCenterId: a.workCenterId };
  const window = { start: a.windowStart, end: a.windowEnd };
  const t0 = Date.now();
  try {
    const stations = await scopeStations(scope, a.businessDate);
    // The scope's parent (workcenter or site) buckets are re-summed by each station's rollup.
    await dropShiftAlignedBuckets(scope.siteId, [scope.workCenterId ?? scope.siteId], window);
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
