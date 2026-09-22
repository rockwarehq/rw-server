import prisma from "@rw/db";
import type { RoleAssignment } from "@rw/db";
import { validateCustomRolePermissions } from "./permissions.js";

export interface CreateAssignmentInput {
  userId: string;
  roleId: string;
  siteId?: string | null;
  workcenterId?: string | null;
}

export class ScopeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeMismatchError";
  }
}

export class SystemUserAssignmentError extends Error {
  constructor(message = "System users cannot hold role assignments") {
    super(message);
    this.name = "SystemUserAssignmentError";
  }
}

/**
 * Assign a role to a user's workspace membership, optionally narrowed to a site.
 *
 * Enforces:
 *  - scope invariant: WORKSPACE roles must have siteId === null;
 *    SITE roles must have siteId !== null and no workcenter;
 *    WORKCENTER roles require a workcenter (site derived and checked).
 *  - membership invariant: the user must be a member of the role's workspace.
 *  - site ownership: the site (if provided) must belong to the role's workspace.
 *  - system-user invariant: internal staff (User.systemRole set) cannot hold
 *    role assignments — their permissions come from code, not the database.
 */
export async function assign(input: CreateAssignmentInput): Promise<RoleAssignment> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, systemRole: true },
  });
  if (!user) throw new Error("User not found");
  if (user.systemRole) throw new SystemUserAssignmentError();

  const role = await prisma.role.findUnique({
    where: { id: input.roleId },
    select: { id: true, workspaceId: true, scope: true, permissions: true },
  });
  if (!role) throw new Error("Role not found");

  let siteId = input.siteId ?? null;
  const workcenterId = input.workcenterId ?? null;

  if (role.scope === "WORKSPACE" && siteId !== null) {
    throw new ScopeMismatchError("Workspace-scoped role cannot be assigned with a siteId");
  }
  if (role.scope === "SITE" && siteId === null) {
    throw new ScopeMismatchError("Site-scoped role requires a siteId");
  }
  if (role.scope !== "WORKCENTER" && workcenterId !== null) {
    throw new ScopeMismatchError("Only workcenter-scoped roles can be assigned with a workcenterId");
  }
  if (role.scope === "WORKCENTER") {
    if (workcenterId === null) throw new ScopeMismatchError("Workcenter-scoped role requires a workcenterId");
    validateCustomRolePermissions(role.permissions, "WORKCENTER");
    const workcenter = await prisma.workcenter.findUnique({
      where: { id: workcenterId },
      select: { siteId: true, site: { select: { workspaceId: true } } },
    });
    if (!workcenter) throw new Error("Workcenter not found");
    if (workcenter.site.workspaceId !== role.workspaceId) {
      throw new ScopeMismatchError("Workcenter does not belong to the role's workspace");
    }
    if (siteId !== null && siteId !== workcenter.siteId) {
      throw new ScopeMismatchError("Workcenter does not belong to the assigned site");
    }
    siteId = workcenter.siteId;
  }

  if (siteId !== null) {
    const site = await prisma.site.findUnique({
      where: { id: siteId },
      select: { workspaceId: true },
    });
    if (!site) throw new Error("Site not found");
    if (site.workspaceId !== role.workspaceId) {
      throw new ScopeMismatchError("Site does not belong to the role's workspace");
    }
  }

  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: role.workspaceId } },
    select: { id: true },
  });
  if (!membership) throw new Error("Workspace membership not found");

  return prisma.roleAssignment.create({
    data: {
      membershipId: membership.id,
      roleId: input.roleId,
      siteId,
      workcenterId,
    },
  });
}

export async function unassign(id: string): Promise<void> {
  await prisma.roleAssignment.delete({ where: { id } });
}

export async function listForUser(userId: string, workspaceId?: string): Promise<RoleAssignment[]> {
  return prisma.roleAssignment.findMany({
    where: { membership: { userId, ...(workspaceId ? { workspaceId } : {}) } },
    orderBy: { createdAt: "asc" },
  });
}

export async function listForWorkspace(workspaceId: string, siteId?: string | null): Promise<RoleAssignment[]> {
  return prisma.roleAssignment.findMany({
    where: {
      membership: { workspaceId },
      ...(siteId === undefined ? {} : { siteId }),
    },
    orderBy: { createdAt: "asc" },
  });
}
