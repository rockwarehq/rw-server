import prisma, { type Prisma } from "@rw/db";

import { resolveEmployee } from "../../employee/actor-role.js";
import { reader, type WriteOptions } from "../../write.js";

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

/**
 * Who is changing a comment. A signed-in user changes their own. An operator
 * terminal (a display, which is no one) changes the terminal comments at its
 * own station — or, with no station, its workcenter: the screen that wrote it
 * stands in for the author, as no user is on record. A terminal changes them
 * only while their shift runs; a user's own comments stay theirs to change.
 */
export type ShiftCommentActor =
  | { kind: "user"; id: string }
  | { kind: "display"; stationId: string | null; workcenterId: string | null };

export interface UpdateShiftCommentInput {
  text: string;
  actor: ShiftCommentActor;
}

export interface RemoveShiftCommentInput {
  actor: ShiftCommentActor;
}

interface CommentOwnership {
  createdById: string | null;
  stationId: string | null;
  workcenterId: string;
  shiftInstance: { endTime: Date };
}

function isAuthor(comment: CommentOwnership, actor: ShiftCommentActor): boolean {
  if (actor.kind === "user") return comment.createdById === actor.id;
  // Only a terminal comment (no user), and only where this display stands.
  if (comment.createdById !== null) return false;
  if (actor.stationId) return comment.stationId === actor.stationId;
  return actor.workcenterId !== null && comment.workcenterId === actor.workcenterId;
}

/** Why `actor` may not change `comment`, or null when they may. */
function refusal(comment: CommentOwnership, actor: ShiftCommentActor, verb: "edit" | "delete") {
  if (!isAuthor(comment, actor)) {
    return { error: `Only the author can ${verb} this comment`, code: "FORBIDDEN" } as const;
  }
  if (actor.kind === "display" && comment.shiftInstance.endTime <= new Date()) {
    return { error: "This shift has ended; its notes can't be changed here", code: "SHIFT_ENDED" } as const;
  }
  return null;
}

const ownershipSelect = {
  id: true,
  createdById: true,
  stationId: true,
  workcenterId: true,
  deletedAt: true,
  shiftInstance: { select: { endTime: true } },
} as const;

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

type ShiftCommentRecord = Prisma.ShiftCommentGetPayload<{ select: typeof commentSelect }>;

export async function create(
  input: CreateShiftCommentInput,
  options?: WriteOptions,
): Promise<{ error: string; code: string } | { data: ShiftCommentRecord }> {
  const db = reader(options);
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

  const shiftInstance = await db.shiftInstance.findUnique({
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
    const station = await db.station.findUnique({
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

  const comment = await db.shiftComment.create({
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
    select: ownershipSelect,
  });

  if (!current || current.deletedAt) {
    return { error: "Shift comment not found", code: "SHIFT_COMMENT_NOT_FOUND" };
  }

  const refused = refusal(current, input.actor, "edit");
  if (refused) return refused;

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
    select: ownershipSelect,
  });

  if (!current || current.deletedAt) {
    return { error: "Shift comment not found", code: "SHIFT_COMMENT_NOT_FOUND" };
  }

  const refused = refusal(current, input.actor, "delete");
  if (refused) return refused;

  await prisma.shiftComment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}
