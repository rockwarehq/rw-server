import prisma from "@rw/db";
import { rematerializePattern } from "@rw/services/facility/shift/materialize";

export interface CreateShiftDefinitionInput {
  patternId: string;
  dayOfRotation: number;
  sortOrder: number;
  startDayOffset?: number;
  startTime: string;
  durationHrs: number;
  shiftName: string;
  isScheduled?: boolean;
}

export interface UpdateShiftDefinitionInput {
  dayOfRotation?: number;
  sortOrder?: number;
  startDayOffset?: number;
  startTime?: string;
  durationHrs?: number;
  shiftName?: string;
  isScheduled?: boolean;
}

export interface ListShiftDefinitionsFilter {
  patternId: string;
  dayOfRotation?: number;
}

/**
 * Create a new shift definition within a pattern
 */
export async function create(input: CreateShiftDefinitionInput) {
  const { patternId, dayOfRotation, sortOrder, startDayOffset, startTime, durationHrs, shiftName, isScheduled } = input;

  const pattern = await prisma.shiftPattern.findUnique({ where: { id: patternId }, select: { id: true } });
  if (!pattern) {
    return { error: "Shift pattern not found", code: "SHIFT_PATTERN_NOT_FOUND" };
  }

  // Check unique constraint [patternId, dayOfRotation, sortOrder]
  const existing = await prisma.shiftDefinition.findUnique({
    where: { patternId_dayOfRotation_sortOrder: { patternId, dayOfRotation, sortOrder } },
    select: { id: true },
  });

  if (existing) {
    return {
      error: `A shift definition already exists for day ${dayOfRotation}, sort order ${sortOrder}`,
      code: "DUPLICATE_SORT_ORDER",
    };
  }

  const definition = await prisma.shiftDefinition.create({
    data: {
      patternId,
      dayOfRotation,
      sortOrder,
      startDayOffset: startDayOffset ?? 0,
      startTime,
      durationHrs,
      shiftName,
      isScheduled: isScheduled ?? true,
    },
  });
  await rematerializePattern(patternId);

  return { data: definition };
}

/**
 * List shift definitions for a pattern
 */
export async function list(filter: ListShiftDefinitionsFilter) {
  const { patternId, dayOfRotation } = filter;

  const where: Record<string, unknown> = { patternId };

  if (dayOfRotation !== undefined) {
    where.dayOfRotation = dayOfRotation;
  }

  const definitions = await prisma.shiftDefinition.findMany({
    where,
    orderBy: [{ dayOfRotation: "asc" }, { sortOrder: "asc" }],
  });

  return { data: definitions };
}

/**
 * Get shift definition by ID
 */
export async function getById(id: string) {
  const definition = await prisma.shiftDefinition.findUnique({
    where: { id },
  });

  if (!definition) {
    return null;
  }

  return { data: definition };
}

/**
 * Update shift definition
 */
export async function update(id: string, input: UpdateShiftDefinitionInput) {
  const { dayOfRotation, sortOrder, startDayOffset, startTime, durationHrs, shiftName, isScheduled } = input;

  const current = await prisma.shiftDefinition.findUnique({ where: { id } });

  if (!current) {
    return { error: "Shift definition not found", code: "SHIFT_DEFINITION_NOT_FOUND" };
  }

  // Check unique constraint if dayOfRotation or sortOrder are changing
  if (dayOfRotation !== undefined || sortOrder !== undefined) {
    const newDay = dayOfRotation ?? current.dayOfRotation;
    const newSort = sortOrder ?? current.sortOrder;

    const existing = await prisma.shiftDefinition.findUnique({
      where: {
        patternId_dayOfRotation_sortOrder: {
          patternId: current.patternId,
          dayOfRotation: newDay,
          sortOrder: newSort,
        },
      },
      select: { id: true },
    });

    if (existing && existing.id !== id) {
      return {
        error: `A shift definition already exists for day ${newDay}, sort order ${newSort}`,
        code: "DUPLICATE_SORT_ORDER",
      };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (dayOfRotation !== undefined) updateData.dayOfRotation = dayOfRotation;
  if (sortOrder !== undefined) updateData.sortOrder = sortOrder;
  if (startDayOffset !== undefined) updateData.startDayOffset = startDayOffset;
  if (startTime !== undefined) updateData.startTime = startTime;
  if (durationHrs !== undefined) updateData.durationHrs = durationHrs;
  if (shiftName !== undefined) updateData.shiftName = shiftName;
  if (isScheduled !== undefined) updateData.isScheduled = isScheduled;

  const definition = await prisma.shiftDefinition.update({
    where: { id },
    data: updateData,
  });
  await rematerializePattern(current.patternId);

  return { data: definition };
}

/**
 * Delete shift definition
 */
export async function remove(id: string) {
  const definition = await prisma.shiftDefinition.findUnique({
    where: { id },
    include: { pattern: { select: { assignment: { select: { rotationStartDefinitionId: true } } } } },
  });

  if (!definition) {
    return { error: "Shift definition not found", code: "SHIFT_DEFINITION_NOT_FOUND" };
  }

  if (definition.pattern.assignment?.rotationStartDefinitionId === id) {
    return {
      error: "This shift anchors the published rotation. Unpublish or change the anchor first.",
      code: "DEFINITION_IS_ROTATION_ANCHOR",
    };
  }

  await prisma.shiftDefinition.delete({ where: { id } });
  await rematerializePattern(definition.patternId);

  return { success: true };
}
