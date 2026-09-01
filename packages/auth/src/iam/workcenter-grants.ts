import prisma from "@rw/db";
import type { WorkcenterAccess, WorkcenterGrant } from "@rw/db";
import { SystemUserAssignmentError } from "./assignments.js";

// GitHub-collaborator-style workcenter grants: a membership holds READ or
// WRITE at one workcenter (one row per pair — upsert to change the level).
// Evaluation happens in permissions.ts; this module is CRUD + invariants,
// mirroring assignments.ts.

export interface UpsertWorkcenterGrantInput {
  userId: string;
  workcenterId: string;
  access: WorkcenterAccess;
}

export interface WorkcenterGrantRef {
  userId: string;
  workcenterId: string;
}

const grantInclude = {
  workcenter: { select: { id: true, name: true, siteId: true } },
} as const;

/**
 * Create or update a grant.
 *
 * Enforces:
 *  - the workcenter exists (its site proves the workspace),
 *  - the user is a member of that workspace,
 *  - system users (User.systemRole set) cannot hold grants — their
 *    permissions come from code, not the database.
 */
export async function upsertGrant(input: UpsertWorkcenterGrantInput) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, systemRole: true },
  });
  if (!user) throw new Error("User not found");
  if (user.systemRole) throw new SystemUserAssignmentError("System users cannot hold workcenter grants");

  const workcenter = await prisma.workcenter.findUnique({
    where: { id: input.workcenterId },
    select: { id: true, site: { select: { workspaceId: true } } },
  });
  if (!workcenter) throw new Error("Workcenter not found");

  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: workcenter.site.workspaceId } },
    select: { id: true },
  });
  if (!membership) throw new Error("Workspace membership not found");

  return prisma.workcenterGrant.upsert({
    where: { membershipId_workcenterId: { membershipId: membership.id, workcenterId: input.workcenterId } },
    update: { access: input.access },
    create: { membershipId: membership.id, workcenterId: input.workcenterId, access: input.access },
    include: grantInclude,
  });
}

/** Remove a grant. No-op if none exists. */
export async function removeGrant(ref: WorkcenterGrantRef): Promise<void> {
  await prisma.workcenterGrant.deleteMany({
    where: { workcenterId: ref.workcenterId, membership: { userId: ref.userId } },
  });
}

export async function listForUser(userId: string, workspaceId: string) {
  return prisma.workcenterGrant.findMany({
    where: { membership: { userId, workspaceId } },
    include: grantInclude,
    orderBy: { createdAt: "asc" },
  });
}

export async function listForWorkspace(workspaceId: string, siteId?: string): Promise<WorkcenterGrant[]> {
  return prisma.workcenterGrant.findMany({
    where: {
      membership: { workspaceId },
      ...(siteId ? { workcenter: { siteId } } : {}),
    },
    include: grantInclude,
    orderBy: { createdAt: "asc" },
  });
}
