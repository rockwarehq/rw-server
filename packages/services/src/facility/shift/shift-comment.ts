import prisma from "@rw/db";

import { resolveEmployee } from "../../employee/actor-role.js";

export interface CreateShiftCommentInput {
  siteId: string;
  shiftInstanceId: string;
  workcenterId: string;
  stationId?: string | null;
  text: string;
  /** The signed-in user, when there is one; null from an operator terminal. */
  createdById: string | null;
  /**
   * The employee writing it. Required in practice from a terminal (the RPC
   * enforces that); for a user, omitted means their linked employee.
   */
  createdByEmployeeId?: string;
}

export interface UpdateShiftCommentInput {
  text: string;
  actorId: string;
}

export interface RemoveShiftCommentInput {
  actorId: string;
}

export interface ListShiftCommentsFilter {
  shiftInstanceId: string;
  workcenterId: string;
}

const commentSelect = {
  id: true,
  siteId: true,
  shiftInstanceId: true,
  workcenterId: true,
  stationId: true,
  text: true,
  createdAt: true,
  updatedAt: true,
  createdBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  createdByEmployee: {
    select: {
      id: true,
      version: { select: { firstName: true, lastName: true, employeeNumber: true } },
    },
  },
} as const;

export async function create(input: CreateShiftCommentInput) {
  const { siteId, shiftInstanceId, workcenterId, stationId, text, createdById, createdByEmployeeId } = input;

  const trimmed = text.trim();
  if (!trimmed) {
    return { error: "Comment text is required", code: "TEXT_REQUIRED" };
  }

  // A comment always has an author: the signed-in user, or — from a
  // terminal, where there is no user — the operator who wrote it.
  if (!createdById && !createdByEmployeeId) {
    return { error: "Choose who is writing this comment", code: "EMPLOYEE_REQUIRED" };
  }

  const shiftInstance = await prisma.shiftInstance.findUnique({
    where: { id: shiftInstanceId },
    select: { id: true, siteId: true, workCenterId: true, site: { select: { workspaceId: true } } },
  });

  if (!shiftInstance) {
    return { error: "Shift instance not found", code: "SHIFT_INSTANCE_NOT_FOUND" };
  }

  if (shiftInstance.siteId !== siteId) {
    return { error: "Shift instance must belong to the specified site", code: "SITE_MISMATCH" };
  }

  if (shiftInstance.workCenterId && shiftInstance.workCenterId !== workcenterId) {
    return {
      error: "Shift instance is scoped to a different workcenter",
      code: "WORKCENTER_MISMATCH",
    };
  }

  if (stationId) {
    const station = await prisma.station.findUnique({
      where: { id: stationId },
      select: { id: true, siteId: true, workcenterId: true },
    });

    if (!station) {
      return { error: "Station not found", code: "STATION_NOT_FOUND" };
    }

    if (station.siteId !== siteId) {
      return { error: "Station must belong to the specified site", code: "SITE_MISMATCH" };
    }

    if (station.workcenterId !== workcenterId) {
      return {
        error: "Station does not belong to the specified workcenter",
        code: "WORKCENTER_MISMATCH",
      };
    }
  }

  const author = await resolveEmployee(shiftInstance.site.workspaceId, createdByEmployeeId, createdById ?? undefined);
  if ("error" in author) return author;

  const comment = await prisma.shiftComment.create({
    data: {
      siteId,
      shiftInstanceId,
      workcenterId,
      stationId: stationId ?? null,
      text: trimmed,
      createdById,
      createdByEmployeeId: author.employeeId,
      createdByEmployeeVersionId: author.employeeVersionId,
    },
    select: commentSelect,
  });

  return { data: comment };
}

export async function list(filter: ListShiftCommentsFilter) {
  const comments = await prisma.shiftComment.findMany({
    where: {
      shiftInstanceId: filter.shiftInstanceId,
      workcenterId: filter.workcenterId,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: commentSelect,
  });

  return { data: comments };
}

export async function update(id: string, input: UpdateShiftCommentInput) {
  const trimmed = input.text.trim();
  if (!trimmed) {
    return { error: "Comment text is required", code: "TEXT_REQUIRED" };
  }

  const current = await prisma.shiftComment.findUnique({
    where: { id },
    select: { id: true, createdById: true, deletedAt: true },
  });

  if (!current || current.deletedAt) {
    return { error: "Shift comment not found", code: "SHIFT_COMMENT_NOT_FOUND" };
  }

  if (current.createdById !== input.actorId) {
    return { error: "Only the author can edit this comment", code: "FORBIDDEN" };
  }

  const comment = await prisma.shiftComment.update({
    where: { id },
    data: { text: trimmed },
    select: commentSelect,
  });

  return { data: comment };
}

export async function remove(id: string, input: RemoveShiftCommentInput) {
  const current = await prisma.shiftComment.findUnique({
    where: { id },
    select: { id: true, createdById: true, deletedAt: true },
  });

  if (!current || current.deletedAt) {
    return { error: "Shift comment not found", code: "SHIFT_COMMENT_NOT_FOUND" };
  }

  if (current.createdById !== input.actorId) {
    return { error: "Only the author can delete this comment", code: "FORBIDDEN" };
  }

  await prisma.shiftComment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}
