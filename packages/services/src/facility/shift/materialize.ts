// ── ShiftInstance auto-materialization ────────────────────────────
//
// Ensures ShiftInstance rows exist for all active ShiftAssignments,
// looking ahead a configurable number of days (default 7).
//
// Runs from the 60-second background worker. Idempotent — uses
// Prisma createMany with skipDuplicates (leveraging the unique
// constraint on [assignmentId, startTime]).
//
// Flow:
//   1. Find active ShiftAssignment records (not ended)
//   2. For each assignment, for each date in [today, today + lookahead]:
//      a. Compute which rotation day applies
//      b. Get ShiftDefinitions for that rotation day
//      c. Convert local start times to UTC using site timezone
//      d. Compute businessDate using pattern's useEndDateForBusinessDate
//      e. Apply ShiftOverride rows for that businessDate (cancel / retime)
//   3. Fill the gaps between consecutive shifts with "Not Scheduled" rows
//      (isScheduled = false) so every instant in the window has a stamp
//   4. Batch insert all new ShiftInstance rows
//
// Gap rows take the business date of the shift before them; a gap longer
// than the rest of that business day (weekend, shutdown) is cut every 24h
// from the day's first shift start so each piece lives in one business date.
// The gap after the last built shift is not emitted (its end is unknown);
// it appears once the next shift enters the window.

import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";
import { getSiteTimezone, getLocalCalendarDate } from "../../metrics/bucket.js";
import { getTimezoneOffsetMs } from "../../metrics/shift.js";

export const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

const DEFAULT_LOOKAHEAD_DAYS = 7;

export const NOT_SCHEDULED_NAME = "Not Scheduled";

// ── Types ────────────────────────────────────────────────────────

export interface ShiftBoundaryCandidate {
  siteId: string;
  workCenterId: string | null;
  startTime: Date;
  endTime: Date;
}

export interface MaterializeResult {
  /** Number of ShiftInstance rows created (0 if all already existed). */
  created: number;
  /** All candidate shift windows (including pre-existing) for boundary scheduling. */
  candidates: ShiftBoundaryCandidate[];
}

export interface ReconcileResult {
  /** Number of new ShiftInstance rows created for the new assignment. */
  created: number;
  /** Number of old ShiftInstance rows deleted (not in use). */
  deleted: number;
  /** Number of old ShiftInstance rows preserved (in use by MetricBucket or ItemDispositionLog). */
  preserved: number;
}

/** Shape of a single ShiftInstance row before insertion. */
export interface InstanceRow {
  assignmentId: string;
  definitionId: string | null;
  siteId: string;
  workCenterId: string | null;
  shiftName: string;
  businessDate: Date;
  startTime: Date;
  endTime: Date;
  isScheduled: boolean;
}

/** The parts of a ShiftOverride the row builder consults. */
export interface OverrideRule {
  businessDate: Date;
  /** null = every shift on that business date. */
  shiftName: string | null;
  startTime: Date | null;
  endTime: Date | null;
  /** null = as defined; false = not worked (named by `label`); true = worked. */
  isScheduled: boolean | null;
  label: string | null;
}

/** Minimal assignment shape needed by the materialization helpers. */
export interface AssignmentWithPattern {
  id: string;
  siteId: string;
  workCenterId: string | null;
  rotationStartDate: Date;
  rotationEndDate: Date | null;
  rotationStartDefinition: {
    dayOfRotation: number;
    sortOrder: number;
  } | null;
  pattern: {
    totalDaysInRotation: number;
    useEndDateForBusinessDate: boolean;
    shifts: Array<{
      id: string;
      dayOfRotation: number;
      sortOrder: number;
      startDayOffset: number;
      startTime: string;
      durationHrs: number;
      shiftName: string;
      isScheduled: boolean;
    }>;
  };
}

interface ShiftInstanceEventRow {
  id: string;
  siteId: string;
  site: { workspaceId: string };
}

// ── Include used to fetch assignments with everything we need ────

export const assignmentIncludeForMaterialize = {
  pattern: {
    include: {
      shifts: {
        orderBy: { sortOrder: "asc" as const },
      },
    },
  },
  rotationStartDefinition: {
    select: {
      dayOfRotation: true,
      sortOrder: true,
    },
  },
};

// ── Public API ───────────────────────────────────────────────────

/**
 * Materialize ShiftInstance rows for all active assignments.
 *
 * Ensures concrete, pre-computed shift windows exist for the next
 * `lookaheadDays` days so that the metrics system can resolve shifts
 * via simple indexed lookups.
 *
 * Safe to call frequently — uses skipDuplicates to avoid inserting
 * rows that already exist.
 */
export async function materializeShiftInstances(options?: { lookaheadDays?: number }): Promise<MaterializeResult> {
  const lookaheadDays = options?.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS;
  const now = new Date();
  const todayMs = Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY;
  const today = new Date(todayMs);

  const assignments = await prisma.shiftAssignment.findMany({
    where: {
      OR: [{ rotationEndDate: null }, { rotationEndDate: { gte: today } }],
    },
    include: assignmentIncludeForMaterialize,
  });

  if (assignments.length === 0) {
    return { created: 0, candidates: [] };
  }

  const allRows: InstanceRow[] = [];
  for (const assignment of assignments) {
    // Start 1 day before UTC today to ensure shifts for the current
    // local business day are materialized even when the UTC date is
    // ahead of the site's local date (e.g., 9pm ET = next day UTC).
    const fromMs = todayMs - MS_PER_DAY;
    allRows.push(...(await buildRowsForAssignment(assignment, fromMs, lookaheadDays + 1, [])));
  }

  const candidates: ShiftBoundaryCandidate[] = allRows.map((r) => ({
    siteId: r.siteId,
    workCenterId: r.workCenterId,
    startTime: r.startTime,
    endTime: r.endTime,
  }));

  if (allRows.length === 0) {
    return { created: 0, candidates };
  }

  const existingKeys = await findExistingShiftInstanceKeys(allRows);
  const result = await prisma.shiftInstance.createMany({
    data: allRows,
    skipDuplicates: true,
  });

  if (result.count > 0) {
    await publishCreatedShiftInstanceEvents(allRows, existingKeys);
  }

  return { created: result.count, candidates };
}

/**
 * Reconcile ShiftInstances when a new assignment is created or an
 * existing assignment's start parameters change.
 *
 * Handles the full transition between old and new shift schedules:
 *   1. Finds overlapping old assignments for the same (siteId, workCenterId)
 *   2. Auto-sets rotationEndDate on old assignments
 *   3. Rebuilds instances from the new start (see rebuildShiftInstances)
 */
export async function reconcileShiftInstances(assignmentId: string): Promise<ReconcileResult> {
  const newAssignment = await prisma.shiftAssignment.findUnique({
    where: { id: assignmentId },
    include: assignmentIncludeForMaterialize,
  });

  if (!newAssignment) {
    return { created: 0, deleted: 0, preserved: 0 };
  }

  const oldAssignments = await prisma.shiftAssignment.findMany({
    where: {
      id: { not: newAssignment.id },
      siteId: newAssignment.siteId,
      workCenterId: newAssignment.workCenterId,
      OR: [{ rotationEndDate: null }, { rotationEndDate: { gte: newAssignment.rotationStartDate } }],
    },
    include: assignmentIncludeForMaterialize,
  });

  if (oldAssignments.length > 0) {
    await prisma.shiftAssignment.updateMany({
      where: {
        id: { in: oldAssignments.map((a) => a.id) },
        OR: [{ rotationEndDate: null }, { rotationEndDate: { gt: newAssignment.rotationStartDate } }],
      },
      data: { rotationEndDate: newAssignment.rotationStartDate },
    });
  }

  // Old assignments only lose their stale rows; the new one is rebuilt.
  return rebuildShiftInstances(
    [...oldAssignments.map((a) => a.id), newAssignment.id],
    [newAssignment],
    newAssignment.rotationStartDate,
  );
}

/**
 * Rebuild instances from `fromTime` onward: rows of `staleAssignmentIds`
 * ending after `fromTime` that are not yet stamped on any fact row are
 * deleted; in-use ones are preserved and become reserved windows the rows
 * regenerated for `build` must avoid. Used by assignment reconcile and by
 * override changes (a changed shift also changes the gap rows around it).
 */
export async function rebuildShiftInstances(
  staleAssignmentIds: string[],
  build: AssignmentWithPattern[],
  fromTime: Date,
): Promise<ReconcileResult> {
  const todayMs = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;

  const stale = await prisma.shiftInstance.findMany({
    where: { assignmentId: { in: staleAssignmentIds }, endTime: { gt: fromTime } },
    include: { site: { select: { workspaceId: true } } },
  });

  let deleted = 0;
  // In-use rows stay as they are; the builder avoids them and fills gaps around them.
  const preserved: InstanceRow[] = [];

  if (stale.length > 0) {
    const inUseIds = await findInUseShiftInstanceIds(stale.map((i) => i.id));
    const toDelete = stale.filter((i) => !inUseIds.has(i.id));
    for (const { id: _id, site: _site, createdAt: _c, ...row } of stale.filter((i) => inUseIds.has(i.id))) {
      preserved.push(row);
    }
    if (toDelete.length > 0) {
      const result = await prisma.shiftInstance.deleteMany({ where: { id: { in: toDelete.map((i) => i.id) } } });
      deleted = result.count;
      publishShiftInstanceEvents("deleted", toDelete);
    }
  }

  const rows: InstanceRow[] = [];
  for (const assignment of build) {
    rows.push(
      ...(await buildRowsForAssignment(assignment, todayMs - MS_PER_DAY, DEFAULT_LOOKAHEAD_DAYS + 1, preserved)),
    );
  }

  let created = 0;
  if (rows.length > 0) {
    const existingKeys = await findExistingShiftInstanceKeys(rows);
    const result = await prisma.shiftInstance.createMany({ data: rows, skipDuplicates: true });
    created = result.count;
    if (created > 0) await publishCreatedShiftInstanceEvents(rows, existingKeys);
  }

  return { created, deleted, preserved: preserved.length };
}

/** Load the site timezone and the scope's overrides, then build scheduled + gap rows. */
async function buildRowsForAssignment(
  assignment: AssignmentWithPattern,
  fromDayMs: number,
  lookaheadDays: number,
  preserved: InstanceRow[],
): Promise<InstanceRow[]> {
  const timezone = await getSiteTimezone(assignment.siteId);
  const overrides = await loadOverrides(assignment, fromDayMs, fromDayMs + (lookaheadDays + 2) * MS_PER_DAY);
  return buildInstanceRows(assignment, fromDayMs, lookaheadDays, preserved, timezone, overrides);
}

/**
 * The rules the builder applies for a scope and date range: overrides, then
 * amendments (ADR-0015). An amendment is the same shape as an override and
 * the latest one per date + shift wins over any override for that shift, so
 * the tick and the calendar reproduce amended days without special cases.
 */
export async function loadOverrides(
  scope: { siteId: string; workCenterId: string | null },
  fromMs: number,
  toMs: number,
): Promise<OverrideRule[]> {
  const where = {
    siteId: scope.siteId,
    workCenterId: scope.workCenterId,
    businessDate: { gte: new Date(fromMs - MS_PER_DAY), lte: new Date(toMs) },
  };
  const select = { businessDate: true, shiftName: true, startTime: true, endTime: true, isScheduled: true, label: true };
  const [overrides, amendments] = await Promise.all([
    prisma.shiftOverride.findMany({ where, select }),
    prisma.shiftAmendment.findMany({ where, select, orderBy: { createdAt: "asc" } }),
  ]);
  const byKey = new Map<string, OverrideRule>();
  for (const rule of [...overrides, ...amendments]) byKey.set(ruleKey(rule), rule);
  return [...byKey.values()];
}

export const ruleKey = (r: { businessDate: Date; shiftName: string | null }) =>
  `${r.businessDate.getTime()}|${r.shiftName ?? ""}`;

/** Assignments of the scope whose rotation can produce rows on `businessDate`. */
export async function assignmentsCovering(siteId: string, workCenterId: string | null, businessDate: Date) {
  return prisma.shiftAssignment.findMany({
    where: {
      siteId,
      workCenterId,
      // Two days of slack each side: a rotation day's rows can carry the next
      // business date (overnight block, end-date rule) or start a day early.
      rotationStartDate: { lte: new Date(businessDate.getTime() + 2 * MS_PER_DAY) },
      OR: [{ rotationEndDate: null }, { rotationEndDate: { gte: new Date(businessDate.getTime() - 2 * MS_PER_DAY) } }],
    },
    include: assignmentIncludeForMaterialize,
  });
}

// ── Core Materialization Logic ──────────────────────────────────

/**
 * Build ShiftInstance rows for a single assignment over a date range.
 *
 * @param assignment      - The assignment with its pattern and shifts
 * @param fromDayMs       - Start of the date range (UTC midnight ms)
 * @param lookaheadDays   - How many days forward to generate
 * @param preserved       - Existing in-use rows to keep: generated rows may not overlap them
 * @param overrides       - ShiftOverride rules for the assignment's scope
 * @returns Scheduled rows plus "Not Scheduled" gap rows (preserved rows included), sorted by start
 */
export function buildInstanceRows(
  assignment: AssignmentWithPattern,
  fromDayMs: number,
  lookaheadDays: number,
  preserved: InstanceRow[] = [],
  timezone: string = "UTC",
  overrides: OverrideRule[] = [],
): InstanceRow[] {
  const { pattern } = assignment;
  const rotationStartMs = floorToDay(assignment.rotationStartDate).getTime();
  const rotationEndMs = assignment.rotationEndDate ? floorToDay(assignment.rotationEndDate).getTime() : Infinity;
  const inRotation = (dayMs: number) => dayMs >= rotationStartMs && dayMs <= rotationEndMs;
  const rows: InstanceRow[] = [];
  const applied = new Set<OverrideRule>();

  for (let dayOffset = 0; dayOffset <= lookaheadDays; dayOffset++) {
    const targetMs = fromDayMs + dayOffset * MS_PER_DAY;
    if (!inRotation(targetMs)) continue;

    // Compute which rotation day applies
    const startDay = assignment.rotationStartDefinition?.dayOfRotation ?? 1;
    const daysSinceStart = Math.floor((targetMs - rotationStartMs) / MS_PER_DAY);
    const rotationDay = ((daysSinceStart + startDay - 1) % pattern.totalDaysInRotation) + 1;

    // Get shift definitions for this rotation day
    let defsForDay = pattern.shifts.filter((d) => d.dayOfRotation === rotationDay);
    if (defsForDay.length === 0) continue;

    // On the first day, skip shifts before the start definition
    if (daysSinceStart === 0 && assignment.rotationStartDefinition) {
      const minSortOrder = assignment.rotationStartDefinition.sortOrder;
      defsForDay = defsForDay.filter((d) => d.sortOrder >= minSortOrder);
      if (defsForDay.length === 0) continue;
    }

    // Pattern times decide the business date; overrides are applied after.
    const shiftsForDay = defsForDay.map((def) => ({
      definition: def,
      ...computeShiftUtcTimes(targetMs, def.startDayOffset, def.startTime, def.durationHrs, timezone),
    }));

    // Compute business date using local calendar dates (not UTC)
    const businessDate = computeBusinessDate(
      shiftsForDay.map((s) => s.utcStartMs),
      shiftsForDay.map((s) => s.utcEndMs),
      pattern.useEndDateForBusinessDate,
      timezone,
    );

    for (const shift of shiftsForDay) {
      const { definition } = shift;
      let { utcStartMs, utcEndMs } = shift;
      const override = findOverride(overrides, businessDate, definition.shiftName);
      if (override) applied.add(override);
      if (override?.startTime && override.endTime) {
        utcStartMs = override.startTime.getTime();
        utcEndMs = override.endTime.getTime();
      }

      if (overlapsAny(utcStartMs, utcEndMs, preserved)) continue;

      rows.push({
        assignmentId: assignment.id,
        definitionId: definition.id,
        siteId: assignment.siteId,
        workCenterId: assignment.workCenterId,
        // An unscheduled definition keeps its name (it is the shift that would run);
        // a shift switched off for one date takes the override's label.
        shiftName: override?.isScheduled === false ? (override.label ?? NOT_SCHEDULED_NAME) : definition.shiftName,
        businessDate,
        startTime: new Date(utcStartMs),
        endTime: new Date(utcEndMs),
        isScheduled: override?.isScheduled ?? definition.isScheduled,
      });
    }
  }

  // A timed override naming a shift the pattern does not have that day adds
  // one (e.g. working a Saturday). It has no definition but is scheduled.
  const rangeStartMs = fromDayMs - MS_PER_DAY;
  const rangeEndMs = fromDayMs + (lookaheadDays + 1) * MS_PER_DAY;
  for (const o of overrides) {
    if (applied.has(o) || !o.shiftName || !o.startTime || !o.endTime || o.isScheduled === false) continue;
    const dateMs = o.businessDate.getTime();
    if (dateMs < rangeStartMs || dateMs > rangeEndMs || !inRotation(dateMs)) continue;
    if (overlapsAny(o.startTime.getTime(), o.endTime.getTime(), preserved)) continue;
    rows.push({
      assignmentId: assignment.id,
      definitionId: null,
      siteId: assignment.siteId,
      workCenterId: assignment.workCenterId,
      shiftName: o.shiftName,
      businessDate: o.businessDate,
      startTime: o.startTime,
      endTime: o.endTime,
      isScheduled: true,
    });
  }

  return fillNotScheduledGaps([...rows, ...preserved]);
}

/** Gap fillers are the only rows with neither a definition nor a schedule. */
export const isGapRow = (row: { definitionId: string | null; isScheduled: boolean }) =>
  row.definitionId === null && !row.isScheduled;

/**
 * Virtual rows for a calendar: what the materializer would write for
 * [from, to] with today's overrides applied. Nothing is persisted. `today`
 * and `started` come from the server clock and the site timezone, so a
 * client never decides from its own clock whether a shift has begun.
 */
export async function previewShiftInstances(
  assignmentId: string,
  from: Date,
  to: Date,
): Promise<{ today: string; rows: Array<InstanceRow & { definitionName: string | null; started: boolean }> }> {
  const assignment = await prisma.shiftAssignment.findUnique({
    where: { id: assignmentId },
    include: assignmentIncludeForMaterialize,
  });
  if (!assignment) return { today: new Date().toISOString().slice(0, 10), rows: [] };
  const now = new Date();
  const today = getLocalCalendarDate(now, await getSiteTimezone(assignment.siteId))
    .toISOString()
    .slice(0, 10);
  const fromMs = floorToDay(from).getTime();
  const days = Math.max(0, Math.round((floorToDay(to).getTime() - fromMs) / MS_PER_DAY));
  // A day of lead so the first date's gaps are anchored like the tick builds
  // them, and two of tail so the last visible day's gaps get closed; then trim.
  const rows = await buildRowsForAssignment(assignment, fromMs - MS_PER_DAY, days + 3, []);
  const cutoffMs = fromMs + (days + 1) * MS_PER_DAY;
  const nameById = new Map(assignment.pattern.shifts.map((d) => [d.id, d.shiftName]));
  return {
    today,
    rows: rows
      .filter((r) => r.startTime.getTime() < cutoffMs)
      .map((r) => ({
        ...r,
        definitionName: r.definitionId ? (nameById.get(r.definitionId) ?? null) : null,
        started: r.startTime <= now,
      })),
  };
}

/** Shift-specific override wins over a whole-day one. */
function findOverride(overrides: OverrideRule[], businessDate: Date, shiftName: string): OverrideRule | undefined {
  const dateMs = businessDate.getTime();
  let dayWide: OverrideRule | undefined;
  for (const o of overrides) {
    if (o.businessDate.getTime() !== dateMs) continue;
    if (o.shiftName === shiftName) return o;
    if (o.shiftName === null) dayWide = o;
  }
  return dayWide;
}

/**
 * Fill the gaps between consecutive rows with "Not Scheduled" rows.
 *
 * A gap belongs to the business date of the row before it and is cut every
 * 24h from that business day's first row start, so a weekend becomes one row
 * per date. The gap after the last row is not emitted (its end is unknown).
 */
export function fillNotScheduledGaps(rows: InstanceRow[]): InstanceRow[] {
  const sorted = [...rows].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  const dayAnchor = new Map<number, number>();
  for (const row of sorted) {
    const key = row.businessDate.getTime();
    dayAnchor.set(key, Math.min(dayAnchor.get(key) ?? Infinity, row.startTime.getTime()));
  }

  const gaps: InstanceRow[] = [];
  let prev: InstanceRow | null = null;
  for (const row of sorted) {
    const startMs = row.startTime.getTime();
    if (prev && startMs > prev.endTime.getTime()) {
      const anchor = dayAnchor.get(prev.businessDate.getTime()) ?? prev.startTime.getTime();
      for (let t = prev.endTime.getTime(); t < startMs; ) {
        const dayIndex = Math.floor((t - anchor) / MS_PER_DAY);
        const chunkEnd = Math.min(startMs, anchor + (dayIndex + 1) * MS_PER_DAY);
        gaps.push({
          assignmentId: prev.assignmentId,
          definitionId: null,
          siteId: prev.siteId,
          workCenterId: prev.workCenterId,
          shiftName: NOT_SCHEDULED_NAME,
          businessDate: new Date(prev.businessDate.getTime() + dayIndex * MS_PER_DAY),
          startTime: new Date(t),
          endTime: new Date(chunkEnd),
          isScheduled: false,
        });
        t = chunkEnd;
      }
    }
    if (!prev || row.endTime > prev.endTime) prev = row;
  }

  return [...sorted, ...gaps].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

/** True when any two rows overlap in time (used to validate override windows). */
export function hasOverlappingRows(rows: InstanceRow[]): boolean {
  const sorted = [...rows].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime < sorted[i - 1].endTime) return true;
  }
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Every table that stamps shiftInstanceId on its rows. A ShiftInstance
 * referenced by ANY of these is "in use" and must survive rematerialization —
 * deleting it would SET NULL (or cascade-delete, for MaterialShiftUsage) the
 * shift dimension on historical fact rows, unrecoverably.
 */
const SHIFT_REFERENCING_TABLES = [
  "MetricBucket", // no FK constraint — informational column
  "MetricBucketLog",
  "ItemDispositionLog",
  "Cycle",
  "InventoryItem",
  "StationStateLog",
  "StationJobLog",
  "StationLogonSession",
  "MaterialShiftUsage",
  "MaterialLedgerEntry",
  "OrderConsumption",
  "ProductStockAdjustment",
  "Call",
  "StationModeLog",
] as const;

/**
 * Find which ShiftInstance IDs are "in use" — referenced by at least one row
 * in any shift-stamped table. One batched DISTINCT query per table.
 */
export async function findInUseShiftInstanceIds(
  instanceIds: string[],
  options: {
    /** Amendments rebuild the buckets in their window, so bucket references alone do not keep a row. */
    ignoreBuckets?: boolean;
    /** Read through the caller's transaction so stamps it just rewrote are seen. */
    client?: Prisma.TransactionClient | typeof prisma;
  } = {},
): Promise<Set<string>> {
  if (instanceIds.length === 0) return new Set();

  const inUse = new Set<string>();
  const client = options.client ?? prisma;
  const tables = options.ignoreBuckets
    ? SHIFT_REFERENCING_TABLES.filter((t) => !t.startsWith("MetricBucket"))
    : SHIFT_REFERENCING_TABLES;
  for (const table of tables) {
    const refs = await client.$queryRawUnsafe<Array<{ shiftInstanceId: string }>>(
      `SELECT DISTINCT "shiftInstanceId" FROM "${table}"
       WHERE "shiftInstanceId" = ANY($1::uuid[])`,
      instanceIds,
    );
    for (const row of refs) inUse.add(row.shiftInstanceId);
  }

  return inUse;
}

async function findExistingShiftInstanceKeys(rows: readonly InstanceRow[]): Promise<Set<string>> {
  if (rows.length === 0) return new Set();

  const rowKeys = new Set(rows.map(shiftInstanceUniqueKey));
  const startTimesByMs = new Map(rows.map((row) => [row.startTime.getTime(), row.startTime]));
  const existing = await prisma.shiftInstance.findMany({
    where: {
      assignmentId: { in: [...new Set(rows.map((row) => row.assignmentId))] },
      startTime: { in: [...startTimesByMs.values()] },
    },
    select: { assignmentId: true, startTime: true },
  });

  return new Set(existing.map(shiftInstanceUniqueKey).filter((key) => rowKeys.has(key)));
}

async function publishCreatedShiftInstanceEvents(rows: readonly InstanceRow[], existingKeys: Set<string>) {
  const createdRows = rows.filter((row) => !existingKeys.has(shiftInstanceUniqueKey(row)));
  if (createdRows.length === 0) return;

  const rowKeys = new Set(createdRows.map(shiftInstanceUniqueKey));
  const startTimesByMs = new Map(createdRows.map((row) => [row.startTime.getTime(), row.startTime]));
  const instances = await prisma.shiftInstance.findMany({
    where: {
      assignmentId: { in: [...new Set(createdRows.map((row) => row.assignmentId))] },
      startTime: { in: [...startTimesByMs.values()] },
    },
    select: {
      id: true,
      assignmentId: true,
      startTime: true,
      siteId: true,
      site: { select: { workspaceId: true } },
    },
  });

  publishShiftInstanceEvents(
    "created",
    instances.filter((instance) => rowKeys.has(shiftInstanceUniqueKey(instance))),
  );
}

export function publishShiftInstanceEvents(
  action: "created" | "updated" | "deleted",
  instances: readonly ShiftInstanceEventRow[],
) {
  for (const instance of instances) {
    publishEntityEvent({
      action,
      entityKey: SYSTEM_ENTITY_KEYS.ShiftInstance,
      entityId: instance.id,
      siteId: instance.siteId,
      workspaceId: instance.site.workspaceId,
    });
  }
}

function shiftInstanceUniqueKey(row: { assignmentId: string; startTime: Date }) {
  return `${row.assignmentId}:${row.startTime.getTime()}`;
}

/** True when [startMs, endMs) overlaps any of `rows`. */
function overlapsAny(startMs: number, endMs: number, rows: InstanceRow[]): boolean {
  return rows.some((r) => startMs < r.endTime.getTime() && endMs > r.startTime.getTime());
}

/**
 * Floor a Date to UTC midnight (start of day).
 */
export function floorToDay(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MS_PER_DAY) * MS_PER_DAY);
}

/**
 * Parse a "HH:mm" time string into milliseconds since midnight.
 */
function parseLocalTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * MS_PER_HOUR + minutes * MS_PER_MINUTE;
}

/**
 * Compute the absolute UTC start and end times for a shift definition
 * on a given rotation day.
 *
 * ShiftDefinition.startTime is the site's LOCAL wall-clock time ("HH:mm"),
 * so a 23:00 shift starts at 23:00 local all year and the UTC instant moves
 * with daylight saving; its end is start + duration on the same local clock.
 * The rotation day is a calendar date (UTC-midnight key); startDayOffset
 * shifts that date (-1 = the evening before).
 *
 * @param targetDayMs   - The rotation day as UTC midnight ms (calendar-date key)
 * @param startDayOffset - Calendar days after (or before) the rotation day the shift starts
 * @param startTimeStr  - Local start time in "HH:mm" format
 * @param durationHrs   - Shift duration in fractional hours
 * @param timezone      - IANA site timezone
 */
function computeShiftUtcTimes(
  targetDayMs: number,
  startDayOffset: number,
  startTimeStr: string,
  durationHrs: number,
  timezone: string,
): { utcStartMs: number; utcEndMs: number } {
  // Duration is wall-clock too: a 23:00 + 8h shift ends at 07:00 local even on
  // a DST changeover night, when that is 9 (or 7) elapsed hours.
  const naiveStart = targetDayMs + startDayOffset * MS_PER_DAY + parseLocalTime(startTimeStr);
  const utcStartMs = localWallClockToUtcMs(naiveStart, timezone);
  const utcEndMs = localWallClockToUtcMs(naiveStart + durationHrs * MS_PER_HOUR, timezone);

  return { utcStartMs, utcEndMs };
}

/**
 * The UTC instant of a local wall-clock time expressed as "naive" ms (the
 * local date and time laid out as if it were UTC).
 *
 * The offsets 12h either side of the time cover any DST change near it. A
 * time that happens twice (fall) takes its first occurrence; one that never
 * happens (spring) resolves forward past the skipped hour.
 */
function localWallClockToUtcMs(naiveMs: number, timezone: string): number {
  const candidates = [-12, 12].map((h) => naiveMs - getTimezoneOffsetMs(timezone, new Date(naiveMs + h * MS_PER_HOUR)));
  const valid = candidates.filter((c) => getTimezoneOffsetMs(timezone, new Date(c)) === naiveMs - c);
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

/**
 * Compute the business date for a block of shifts on a rotation day.
 *
 * Uses the site's timezone to determine the LOCAL calendar date, not
 * the UTC date. This matters when shifts cross UTC midnight but not
 * local midnight (e.g., a shift ending at 03:00 UTC is still April 9
 * in America/New_York because 03:00 UTC = 11:00 PM ET on April 9).
 *
 * The false branch must use the FIRST shift's actual start, not the
 * rotation anchor: for west-of-UTC sites the anchor (UTC midnight) is
 * the previous local evening, which stamped every block one day early.
 * For UTC and east-of-UTC sites both dates coincide, so existing
 * tenants' stamps are unchanged.
 *
 * @param shiftStartTimesMs         - UTC start times of all shifts on this day
 * @param shiftEndTimesMs           - UTC end times of all shifts on this day
 * @param useEndDateForBusinessDate - Pattern flag controlling the rule
 * @param timezone                  - IANA timezone string (e.g., "America/New_York")
 */
export function computeBusinessDate(
  shiftStartTimesMs: number[],
  shiftEndTimesMs: number[],
  useEndDateForBusinessDate: boolean,
  timezone: string,
): Date {
  if (!useEndDateForBusinessDate) {
    // Business date = local calendar date when the FIRST shift starts
    const firstStartMs = Math.min(...shiftStartTimesMs);
    return getLocalCalendarDate(new Date(firstStartMs), timezone);
  }

  // Business date = local calendar date when the LAST shift ends
  const lastEndMs = Math.max(...shiftEndTimesMs);
  return getLocalCalendarDate(new Date(lastEndMs), timezone);
}
