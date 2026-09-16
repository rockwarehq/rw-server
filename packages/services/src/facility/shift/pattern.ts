import prisma from "@rw/db";
import { rematerializePattern } from "@rw/services/facility/shift/materialize";
import { unpublish } from "./assignment.js";

export interface CreateShiftPatternInput {
  name: string;
  siteId: string;
  totalDaysInRotation?: number;
  startOnDayOfWeek?: string;
  useEndDateForBusinessDate?: boolean;
}

export interface UpdateShiftPatternInput {
  name?: string;
  totalDaysInRotation?: number;
  startOnDayOfWeek?: string | null;
  useEndDateForBusinessDate?: boolean;
}

export interface ListShiftPatternsFilter {
  siteId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

const patternInclude = {
  shifts: {
    orderBy: { sortOrder: "asc" as const },
  },
  assignment: {
    select: {
      id: true,
      rotationStartDate: true,
      rotationEndDate: true,
      rotationStartDefinitionId: true,
      rotationStartDefinition: {
        select: {
          id: true,
          dayOfRotation: true,
          sortOrder: true,
          startTime: true,
          shiftName: true,
        },
      },
      siteId: true,
      workCenterId: true,
    },
  },
  _count: { select: { shifts: true } },
};

/** Published = has an assignment that has not ended (server clock). */
const withPublished = <T extends { assignment: { rotationEndDate: Date | null } | null }>(pattern: T) => ({
  ...pattern,
  isPublished:
    !!pattern.assignment && (!pattern.assignment.rotationEndDate || pattern.assignment.rotationEndDate > new Date()),
});

/**
 * Create a new shift pattern
 */
export async function create(input: CreateShiftPatternInput) {
  const { name, siteId, totalDaysInRotation, startOnDayOfWeek, useEndDateForBusinessDate } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const pattern = await prisma.shiftPattern.create({
    data: {
      name,
      siteId,
      totalDaysInRotation: totalDaysInRotation ?? 8,
      startOnDayOfWeek: startOnDayOfWeek ?? null,
      useEndDateForBusinessDate: useEndDateForBusinessDate ?? true,
    },
    include: patternInclude,
  });

  return { data: withPublished(pattern) };
}

/**
 * List shift patterns with optional filtering
 */
export async function list(filter: ListShiftPatternsFilter = {}) {
  const { siteId, name, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = { deletedAt: null };

  if (siteId) {
    where.siteId = siteId;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [patterns, total] = await Promise.all([
    prisma.shiftPattern.findMany({
      where,
      include: patternInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.shiftPattern.count({ where }),
  ]);

  return {
    data: patterns.map(withPublished),
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get shift pattern by ID with definitions and assignment
 */
export async function getById(id: string) {
  const pattern = await prisma.shiftPattern.findUnique({
    where: { id },
    include: patternInclude,
  });

  if (!pattern) {
    return null;
  }

  return { data: withPublished(pattern) };
}

/**
 * Update shift pattern
 */
export async function update(id: string, input: UpdateShiftPatternInput) {
  const { name, totalDaysInRotation, startOnDayOfWeek, useEndDateForBusinessDate } = input;

  const current = await prisma.shiftPattern.findUnique({ where: { id }, select: { id: true } });

  if (!current) {
    return { error: "Shift pattern not found", code: "SHIFT_PATTERN_NOT_FOUND" };
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (totalDaysInRotation !== undefined) updateData.totalDaysInRotation = totalDaysInRotation;
  if (startOnDayOfWeek !== undefined) updateData.startOnDayOfWeek = startOnDayOfWeek;
  if (useEndDateForBusinessDate !== undefined) updateData.useEndDateForBusinessDate = useEndDateForBusinessDate;

  const pattern = await prisma.shiftPattern.update({
    where: { id },
    data: updateData,
    include: patternInclude,
  });
  // Only a change that moves a boundary is worth rebuilding the week for; a
  // rename does not.
  const movesShifts =
    totalDaysInRotation !== undefined || useEndDateForBusinessDate !== undefined || startOnDayOfWeek !== undefined;
  if (movesShifts) await rematerializePattern(id);

  return { data: withPublished(pattern) };
}

/**
 * Delete shift pattern (fails if assigned)
 */
export async function remove(id: string) {
  const pattern = await prisma.shiftPattern.findUnique({
    where: { id },
    include: { assignment: { select: { id: true } } },
  });

  if (!pattern) {
    return { error: "Shift pattern not found", code: "SHIFT_PATTERN_NOT_FOUND" };
  }

  // A published pattern's assignment anchors the instances history is stamped
  // on, so it is ended now and hidden; only a never-published one is removed.
  if (pattern.assignment) {
    const ended = await unpublish(pattern.assignment.id);
    if ("error" in ended) return ended;
    await prisma.shiftPattern.update({ where: { id }, data: { deletedAt: new Date() } });
  } else {
    await prisma.shiftPattern.delete({ where: { id } });
  }

  return { success: true };
}

/**
 * Duplicate a shift pattern and all its definitions
 */
export async function duplicate(id: string, newName?: string) {
  const source = await prisma.shiftPattern.findUnique({
    where: { id },
    include: {
      shifts: true,
    },
  });

  if (!source) {
    return { error: "Shift pattern not found", code: "SHIFT_PATTERN_NOT_FOUND" };
  }

  const pattern = await prisma.$transaction(async (tx) => {
    // 1. Create cloned pattern
    const cloned = await tx.shiftPattern.create({
      data: {
        name: newName ?? `${source.name} (Copy)`,
        siteId: source.siteId,
        totalDaysInRotation: source.totalDaysInRotation,
        startOnDayOfWeek: source.startOnDayOfWeek,
        useEndDateForBusinessDate: source.useEndDateForBusinessDate,
        clonedFromId: source.id,
      },
    });

    // 2. Clone all shift definitions
    if (source.shifts.length > 0) {
      await tx.shiftDefinition.createMany({
        data: source.shifts.map((def) => ({
          patternId: cloned.id,
          dayOfRotation: def.dayOfRotation,
          sortOrder: def.sortOrder,
          startDayOffset: def.startDayOffset,
          startTime: def.startTime,
          durationHrs: def.durationHrs,
          shiftName: def.shiftName,
        })),
      });
    }

    // 3. Return with includes
    return tx.shiftPattern.findUnique({
      where: { id: cloned.id },
      include: patternInclude,
    });
  });

  // biome-ignore lint/style/noNonNullAssertion: pattern is the result of findUnique on a row just created in the same transaction
  return { data: withPublished(pattern!) };
}
