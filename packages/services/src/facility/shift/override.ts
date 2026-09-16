// ShiftOverride: one-off changes to a specific business date's shifts.
// Every write rebuilds the scope's instances from the day before the date
// (gap rows on the previous day end where the changed shift starts).

import prisma from "@rw/db";
import type { ShiftOverride } from "@rw/db";
import {
  type AssignmentWithPattern,
  assignmentsCovering,
  buildInstanceRows,
  floorToDay,
  hasOverlappingRows,
  isGapRow,
  loadOverrides,
  MS_PER_DAY,
  type OverrideRule,
  rebuildShiftInstances,
  ruleKey,
} from "@rw/services/facility/shift/materialize";
import { getSiteTimezone } from "../../metrics/bucket.js";

export interface CreateShiftOverrideInput {
  siteId: string;
  workCenterId?: string | null;
  businessDate: Date;
  shiftName?: string | null;
  startTime?: Date | null;
  endTime?: Date | null;
  /** null = as defined; false = not worked (named by `label`); true = worked. */
  isScheduled?: boolean | null;
  label?: string | null;
}

export interface UpdateShiftOverrideInput {
  startTime?: Date | null;
  endTime?: Date | null;
  isScheduled?: boolean | null;
  label?: string | null;
}

export interface ListShiftOverridesFilter {
  siteId: string;
  workCenterId?: string | null;
  from?: Date;
  to?: Date;
}

type OverrideResult = { data: ShiftOverride } | { error: string; code: string };

export async function create(input: CreateShiftOverrideInput): Promise<OverrideResult> {
  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) return { error: "Site not found", code: "SITE_NOT_FOUND" };

  const workCenterId = input.workCenterId ?? null;
  if (workCenterId) {
    const wc = await prisma.workcenter.findUnique({ where: { id: workCenterId }, select: { siteId: true } });
    if (!wc) return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
    if (wc.siteId !== input.siteId) return { error: "Workcenter must belong to the same site", code: "SITE_MISMATCH" };
  }

  const rule: OverrideRule = {
    businessDate: floorToDay(input.businessDate),
    shiftName: input.shiftName ?? null,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    isScheduled: input.isScheduled ?? null,
    label: input.label ?? null,
  };
  const invalid = validateRule(rule);
  if (invalid) return invalid;

  const duplicate = await prisma.shiftOverride.findFirst({
    where: { siteId: input.siteId, workCenterId, businessDate: rule.businessDate, shiftName: rule.shiftName },
    select: { id: true },
  });
  if (duplicate) return { error: "An override already exists for this date and shift", code: "SHIFT_OVERRIDE_EXISTS" };

  const assignments = await assignmentsCovering(input.siteId, workCenterId, rule.businessDate);
  const overlap = await overlapError({ siteId: input.siteId, workCenterId }, rule, assignments);
  if (overlap) return overlap;

  const override = await prisma.shiftOverride.create({ data: { siteId: input.siteId, workCenterId, ...rule } });
  await rebuildFrom(assignments, rule.businessDate);
  return { data: override };
}

export async function update(id: string, input: UpdateShiftOverrideInput): Promise<OverrideResult> {
  const current = await prisma.shiftOverride.findUnique({ where: { id } });
  if (!current) return { error: "Shift override not found", code: "SHIFT_OVERRIDE_NOT_FOUND" };

  const rule: OverrideRule = {
    businessDate: current.businessDate,
    shiftName: current.shiftName,
    startTime: input.startTime !== undefined ? input.startTime : current.startTime,
    endTime: input.endTime !== undefined ? input.endTime : current.endTime,
    isScheduled: input.isScheduled !== undefined ? input.isScheduled : current.isScheduled,
    label: input.label !== undefined ? input.label : current.label,
  };
  const invalid = validateRule(rule);
  if (invalid) return invalid;

  const assignments = await assignmentsCovering(current.siteId, current.workCenterId, rule.businessDate);
  const overlap = await overlapError(current, rule, assignments);
  if (overlap) return overlap;

  const override = await prisma.shiftOverride.update({ where: { id }, data: rule });
  await rebuildFrom(assignments, rule.businessDate);
  return { data: override };
}

export async function remove(id: string) {
  const current = await prisma.shiftOverride.findUnique({ where: { id } });
  if (!current) return { error: "Shift override not found", code: "SHIFT_OVERRIDE_NOT_FOUND" };

  await prisma.shiftOverride.delete({ where: { id } });
  await rebuildFrom(
    await assignmentsCovering(current.siteId, current.workCenterId, current.businessDate),
    current.businessDate,
  );
  return { success: true };
}

export async function getById(id: string) {
  const override = await prisma.shiftOverride.findUnique({ where: { id } });
  return override ? { data: override } : null;
}

export async function list(filter: ListShiftOverridesFilter) {
  return prisma.shiftOverride.findMany({
    // Prisma drops undefined filters, so an absent bound means unbounded.
    where: {
      siteId: filter.siteId,
      workCenterId: filter.workCenterId,
      businessDate: { gte: filter.from, lte: filter.to },
    },
    orderBy: [{ businessDate: "asc" }, { startTime: "asc" }],
  });
}

export function validateRule(rule: OverrideRule) {
  const hasStart = rule.startTime !== null;
  const hasEnd = rule.endTime !== null;
  if (hasStart !== hasEnd) return { error: "startTime and endTime must be set together", code: "INVALID_OVERRIDE" };
  if (hasStart && (rule.endTime as Date) <= (rule.startTime as Date)) {
    return { error: "endTime must be after startTime", code: "INVALID_OVERRIDE" };
  }
  if (rule.isScheduled === null && !hasStart) return { error: "Override changes nothing", code: "INVALID_OVERRIDE" };
  return null;
}

/**
 * Dry-run the row builder with `rule` replacing any same-key override and
 * report an error when the resulting windows overlap a neighbouring shift
 * (added shifts included; gap fillers are regenerated afterwards).
 */
export async function overlapError(
  scope: { siteId: string; workCenterId: string | null },
  rule: OverrideRule,
  assignments: AssignmentWithPattern[],
) {
  if (!rule.startTime) return null;
  const fromMs = rule.businessDate.getTime() - 2 * MS_PER_DAY;
  const others = (await loadOverrides(scope, fromMs, fromMs + 6 * MS_PER_DAY)).filter(
    (o) => ruleKey(o) !== ruleKey(rule),
  );
  const timezone = await getSiteTimezone(scope.siteId);
  for (const assignment of assignments) {
    const rows = buildInstanceRows(assignment, fromMs, 5, [], timezone, [...others, rule]);
    if (hasOverlappingRows(rows.filter((r) => !isGapRow(r)))) {
      return { error: "Override window overlaps another shift", code: "SHIFT_OVERRIDE_OVERLAPS" };
    }
  }
  return null;
}

/** Rebuild the scope's rows from the day before (its gap rows end where this date's shifts start). */
async function rebuildFrom(assignments: AssignmentWithPattern[], businessDate: Date) {
  if (assignments.length === 0) return;
  await rebuildShiftInstances(
    assignments.map((a) => a.id),
    assignments,
    new Date(businessDate.getTime() - MS_PER_DAY),
  );
}
