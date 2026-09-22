import prisma, { type Prisma } from "@rw/db";
import { type IAMContext, Principal } from "@rw/auth/context";
import { authorize } from "@rw/auth/iam/policy";
import type { ActionActor } from "../../employee/actor-role.js";

export interface CreateShiftCommentInput {
  siteId: string;
  shiftInstanceId: string;
  workcenterId: string;
  stationId?: string | null;
  text: string;
  createdById?: string;
  /** Server-resolved identity; never populated directly from client input. */
  actor?: ActionActor;
}

export interface UpdateShiftCommentInput {
  text: string;
  actorId?: string;
  actor?: ActionActor;
}

export interface RemoveShiftCommentInput {
  actorId: string;
  iam: IAMContext;
}

export interface ListShiftCommentsFilter {
  shiftInstanceId: string;
  workcenterId: string;
  siteId?: string;
  /** Optional explicit filter: WC-wide comments plus this station's comments. */
  stationId?: string;
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
  createdById: true,
  authorKind: true,
  authorId: true,
  authorEmployeeId: true,
  authorAssurance: true,
  sourceDisplayId: true,
  operatorSessionId: true,
  authorEmployee: { select: { version: { select: { firstName: true, lastName: true } } } },
  authorDisplay: { select: { name: true } },
  createdBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
} as const;

function toCommentDTO(row: Prisma.ShiftCommentGetPayload<{ select: typeof commentSelect }>) {
  const { authorEmployee, authorDisplay, ...comment } = row;
  const name =
    row.authorKind === "USER"
      ? [row.createdBy?.firstName, row.createdBy?.lastName].filter(Boolean).join(" ") || row.createdBy?.email || null
      : row.authorKind === "EMPLOYEE"
        ? [authorEmployee?.version?.firstName, authorEmployee?.version?.lastName].filter(Boolean).join(" ") || null
        : row.authorKind === "DISPLAY"
          ? (authorDisplay?.name ?? "Terminal")
          : null;
  return {
    ...comment,
    author: {
      kind: row.authorKind,
      id: row.authorId,
      employeeId: row.authorEmployeeId,
      name,
      assurance: row.authorAssurance,
    },
  };
}

type ShiftCommentDTO = ReturnType<typeof toCommentDTO>;
type Result<T> = { data: T; error?: never; code?: never } | { data?: never; error: string; code: string };

/** Validate the complete related-id tuple, including site-default shifts. */
export async function validateLocation(input: {
  siteId: string;
  shiftInstanceId: string;
  workcenterId: string;
  stationId?: string | null;
}) {
  const shift = await prisma.shiftInstance.findUnique({
    where: { id: input.shiftInstanceId },
    select: { siteId: true, workCenterId: true },
  });
  if (!shift) return { error: "Shift instance not found", code: "SHIFT_INSTANCE_NOT_FOUND" };
  if (shift.siteId !== input.siteId) {
    return { error: "Shift instance must belong to the specified site", code: "SITE_MISMATCH" };
  }
  if (shift.workCenterId && shift.workCenterId !== input.workcenterId) {
    return { error: "Shift instance is scoped to a different workcenter", code: "WORKCENTER_MISMATCH" };
  }
  const workcenter = await prisma.workcenter.findUnique({
    where: { id: input.workcenterId },
    select: { siteId: true },
  });
  if (!workcenter || workcenter.siteId !== input.siteId) {
    return { error: "Workcenter must belong to the specified site", code: "WORKCENTER_MISMATCH" };
  }
  if (input.stationId) {
    const station = await prisma.station.findUnique({
      where: { id: input.stationId },
      select: { siteId: true, workcenterId: true },
    });
    if (!station) return { error: "Station not found", code: "STATION_NOT_FOUND" };
    if (station.siteId !== input.siteId || station.workcenterId !== input.workcenterId) {
      return { error: "Station does not belong to the specified site/workcenter", code: "WORKCENTER_MISMATCH" };
    }
  }
  return null;
}

export async function create(input: CreateShiftCommentInput): Promise<Result<ShiftCommentDTO>> {
  const { siteId, shiftInstanceId, workcenterId, stationId, text, createdById } = input;

  const trimmed = text.trim();
  if (!trimmed) {
    return { error: "Comment text is required", code: "TEXT_REQUIRED" };
  }

  const invalid = await validateLocation(input);
  if (invalid) return invalid;
  const actor: ActionActor | undefined =
    input.actor ??
    (createdById
      ? {
          userId: createdById,
          employeeId: null,
          employeeVersionId: null,
          assurance: "ACCOUNT",
        }
      : undefined);
  if (!actor) return { error: "Comment author is required", code: "FORBIDDEN" };
  const authorKind = actor.userId ? "USER" : actor.employeeId ? "EMPLOYEE" : "DISPLAY";
  const authorId = actor.userId ?? actor.employeeId ?? actor.displayId;
  if (!authorId) return { error: "Comment author is required", code: "FORBIDDEN" };

  const comment = await prisma.shiftComment.create({
    data: {
      siteId,
      shiftInstanceId,
      workcenterId,
      stationId: stationId ?? null,
      text: trimmed,
      createdById: actor.userId ?? null,
      authorKind,
      authorId,
      // Capture the person link at creation; never infer legacy ownership from a later membership change.
      authorEmployeeId: actor.employeeId,
      authorDisplayId: authorKind === "DISPLAY" ? actor.displayId : null,
      sourceDisplayId: actor.displayId ?? null,
      operatorSessionId: actor.operatorSessionId ?? null,
      authorEmployeeVersionId: actor.employeeVersionId,
      authorAssurance: actor.assurance,
    },
    select: commentSelect,
  });

  return { data: toCommentDTO(comment) };
}

export async function list(filter: ListShiftCommentsFilter) {
  const comments = await prisma.shiftComment.findMany({
    where: {
      shiftInstanceId: filter.shiftInstanceId,
      workcenterId: filter.workcenterId,
      siteId: filter.siteId,
      ...(filter.stationId ? { OR: [{ stationId: null }, { stationId: filter.stationId }] } : {}),
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: commentSelect,
  });

  return { data: comments.map(toCommentDTO) };
}

export async function getLocation(id: string) {
  return prisma.shiftComment.findFirst({
    where: { id, deletedAt: null },
    select: { siteId: true, shiftInstanceId: true, workcenterId: true, stationId: true },
  });
}

export function isCommentAuthor(
  comment: { authorKind: string; authorId: string | null; authorEmployeeId?: string | null },
  actor: ActionActor,
): boolean {
  if (!comment.authorId) return false;
  // The actor has already been resolved from an enabled identification method.
  // Comment ownership does not introduce a PIN requirement of its own.
  const identifiedEmployee = ["IDENTIFIED", "VERIFIED", "ACCOUNT"].includes(actor.assurance);
  switch (comment.authorKind) {
    case "USER":
      return (
        actor.userId === comment.authorId ||
        (!!comment.authorEmployeeId && actor.employeeId === comment.authorEmployeeId && identifiedEmployee)
      );
    case "EMPLOYEE":
      return actor.employeeId === comment.authorId && identifiedEmployee;
    case "DISPLAY":
      return !actor.userId && actor.displayId === comment.authorId;
    default:
      return false;
  }
}

export async function update(id: string, input: UpdateShiftCommentInput): Promise<Result<ShiftCommentDTO>> {
  const trimmed = input.text.trim();
  if (!trimmed) {
    return { error: "Comment text is required", code: "TEXT_REQUIRED" };
  }

  const current = await prisma.shiftComment.findUnique({
    where: { id },
    select: { id: true, authorKind: true, authorId: true, authorEmployeeId: true, deletedAt: true },
  });

  if (!current || current.deletedAt) {
    return { error: "Shift comment not found", code: "SHIFT_COMMENT_NOT_FOUND" };
  }

  const actor: ActionActor = input.actor ?? {
    userId: input.actorId,
    employeeId: null,
    employeeVersionId: null,
    assurance: "ACCOUNT",
  };
  if (!isCommentAuthor(current, actor)) {
    return { error: "Only the author can edit this comment", code: "FORBIDDEN" };
  }

  const comment = await prisma.shiftComment.update({
    where: { id, deletedAt: null },
    data: { text: trimmed },
    select: commentSelect,
  });

  return { data: toCommentDTO(comment) };
}

export async function remove(id: string, input: RemoveShiftCommentInput) {
  const current = await prisma.shiftComment.findUnique({
    where: { id },
    select: { id: true, siteId: true, workcenterId: true, deletedAt: true },
  });

  if (!current || current.deletedAt) {
    return { error: "Shift comment not found", code: "SHIFT_COMMENT_NOT_FOUND" };
  }

  if (input.iam.principal !== Principal.USER || input.iam.id !== input.actorId || !input.iam.validToken) {
    return { error: "Comment deletion requires an administrator account", code: "FORBIDDEN" };
  }
  const admin =
    (
      await authorize(input.iam, {
        permission: "plant:admin",
        scope: { kind: "site", siteId: current.siteId },
      })
    ).ok ||
    (
      await authorize(input.iam, {
        permission: "production:admin",
        scope: { kind: "site", siteId: current.siteId, workcenterId: current.workcenterId },
      })
    ).ok;
  if (!admin) {
    return { error: "Comment deletion requires administration of this workcenter", code: "FORBIDDEN" };
  }

  await prisma.shiftComment.update({
    where: { id, deletedAt: null },
    data: { deletedAt: new Date(), deletedById: input.actorId },
  });

  return { success: true };
}
