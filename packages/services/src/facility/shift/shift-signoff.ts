import prisma from "@rw/db";

/**
 * Shift recap sign-off ("post"): at most one ACTIVE sign-off per
 * (shiftInstance, workcenter) pair. Reopening soft-deletes the row while
 * recording who reopened it; a later re-post revives the same row. The shift
 * instance may be site-level (workCenterId null) and shared by several
 * workcenters, so the workcenter is part of the key.
 */

export interface GetShiftSignoffFilter {
  shiftInstanceId: string;
  workcenterId: string;
}

export interface CreateShiftSignoffInput {
  siteId: string;
  shiftInstanceId: string;
  workcenterId: string;
  postedById: string;
}

export interface RemoveShiftSignoffInput {
  siteId: string;
  shiftInstanceId: string;
  workcenterId: string;
  actorId: string;
}

const signoffSelect = {
  id: true,
  siteId: true,
  shiftInstanceId: true,
  workcenterId: true,
  postedAt: true,
  createdAt: true,
  updatedAt: true,
  postedBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
} as const;

export async function get(filter: GetShiftSignoffFilter) {
  const signoff = await prisma.shiftSignoff.findFirst({
    where: {
      shiftInstanceId: filter.shiftInstanceId,
      workcenterId: filter.workcenterId,
      deletedAt: null,
    },
    select: signoffSelect,
  });

  return { data: signoff };
}

export async function create(input: CreateShiftSignoffInput) {
  const { siteId, shiftInstanceId, workcenterId, postedById } = input;

  const shiftInstance = await prisma.shiftInstance.findUnique({
    where: { id: shiftInstanceId },
    select: { id: true, siteId: true, workCenterId: true },
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

  const existing = await prisma.shiftSignoff.findUnique({
    where: { shiftInstanceId_workcenterId: { shiftInstanceId, workcenterId } },
    select: { id: true, deletedAt: true },
  });

  if (existing && !existing.deletedAt) {
    return { error: "Shift recap is already signed off", code: "ALREADY_SIGNED_OFF" };
  }

  const now = new Date();
  const signoff = existing
    ? await prisma.shiftSignoff.update({
        where: { id: existing.id },
        data: { postedById, postedAt: now, reopenedById: null, deletedAt: null },
        select: signoffSelect,
      })
    : await prisma.shiftSignoff.create({
        data: { siteId, shiftInstanceId, workcenterId, postedById, postedAt: now },
        select: signoffSelect,
      });

  return { data: signoff };
}

export async function remove(input: RemoveShiftSignoffInput) {
  const current = await prisma.shiftSignoff.findUnique({
    where: {
      shiftInstanceId_workcenterId: {
        shiftInstanceId: input.shiftInstanceId,
        workcenterId: input.workcenterId,
      },
    },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!current || current.deletedAt || current.siteId !== input.siteId) {
    return { error: "Shift recap sign-off not found", code: "SIGNOFF_NOT_FOUND" };
  }

  await prisma.shiftSignoff.update({
    where: { id: current.id },
    data: { deletedAt: new Date(), reopenedById: input.actorId },
  });

  return { success: true };
}
