import prisma from "@rw/db";
import { Prisma, type Role } from "@rw/db";
import {
  hasAnyPermission,
  hasOwnerPermission,
  hasPermission,
  OWNER_PERMISSION,
  type Permission,
} from "@rw/auth/iam/index";
import { findSystemRole } from "@rw/auth/iam/roles";
import { logEvent } from "@rw/services/audit/index";

const USER_ROLE_ASSIGNMENT_PERMISSIONS: readonly Permission[] = ["user:write", "user:admin"];

export interface RoleRef {
  [x: string]: unknown;
  id: string;
  name: string;
  isSystem: boolean;
}

export interface RoleAssignmentRef {
  [x: string]: unknown;
  id: string;
  siteId: string | null;
  site: { id: string; name: string } | null;
  role: RoleRef & {
    scope: "WORKSPACE" | "SITE";
    permissions: string[];
  };
}

export interface SitePermissionSummary {
  [x: string]: unknown;
  siteId: string;
  site: { id: string; name: string } | null;
  permissions: Permission[];
}

export interface WorkcenterGrantRef {
  [x: string]: unknown;
  id: string;
  workcenterId: string;
  access: "READ" | "WRITE";
  workcenter: { id: string; name: string; siteId: string };
}

export interface WorkspaceAccessSummary {
  roles: RoleRef[];
  roleAssignments: RoleAssignmentRef[];
  workcenterGrants: WorkcenterGrantRef[];
  access: {
    workspacePermissions: Permission[];
    sitePermissions: SitePermissionSummary[];
    sites: { all: boolean; siteIds: string[] };
  };
}

interface EmployeeProfileSummary {
  [x: string]: unknown;
  id: string;
  status: "ACTIVE" | "INACTIVE";
  version: {
    id: string;
    version: number;
    firstName: string;
    lastName: string;
    employeeNumber: string | null;
    badgeNumber: string | null;
  } | null;
}

export interface WorkspaceMembership {
  [x: string]: unknown;
  id: string;
  name: string;
  slug: string;
  description: string | null;
  joinedAt: Date;
  // Role names this user holds at workspace scope in this workspace. May be
  // empty for members whose access comes only from workcenter grants.
  employee: EmployeeProfileSummary | null;
  roles: RoleRef[];
  roleAssignments: RoleAssignmentRef[];
  workcenterGrants: WorkcenterGrantRef[];
  access: WorkspaceAccessSummary["access"];
}

export interface UpdateRoleInput {
  actorUserId: string;
  targetUserId: string;
  workspaceId: string;
  siteId?: string;
  roleId: string;
}

export type UpdateRoleErrorCode =
  | "FORBIDDEN"
  | "ROLE_NOT_FOUND"
  | "ROLE_WORKSPACE_MISMATCH"
  | "MEMBER_NOT_FOUND"
  | "SITE_CONTEXT_REQUIRED"
  | "SITE_NOT_FOUND"
  | "SITE_WORKSPACE_MISMATCH"
  | "OWNER_PERMISSION_RESERVED"
  | "OWNER_PERMISSION_REQUIRED"
  | "LAST_OWNER";

export type UpdateRoleResult =
  | { success: true; data: { [x: string]: unknown } }
  | { success: false; code: UpdateRoleErrorCode; error: string };

function updateRoleError(code: UpdateRoleErrorCode, error: string): UpdateRoleResult {
  return { success: false, code, error };
}

function isOwnerRole(role: Pick<Role, "isSystem" | "scope" | "permissions">): boolean {
  return role.isSystem && role.scope === "WORKSPACE" && hasOwnerPermission(role.permissions);
}

function hasReservedOwnerPermission(role: Pick<Role, "isSystem" | "scope" | "permissions">): boolean {
  return hasOwnerPermission(role.permissions) && !isOwnerRole(role);
}

function sortPermissions(permissions: Iterable<Permission>): Permission[] {
  return [...permissions].sort();
}

function buildWorkspaceAccessSummary(
  assignments: Array<{
    id: string;
    siteId: string | null;
    site: { id: string; name: string } | null;
    role: {
      id: string;
      name: string;
      isSystem: boolean;
      scope: "WORKSPACE" | "SITE";
      permissions: string[];
    };
  }>,
  workcenterGrants: Array<{
    id: string;
    workcenterId: string;
    access: "READ" | "WRITE";
    workcenter: { id: string; name: string; siteId: string };
  }> = [],
): WorkspaceAccessSummary {
  const workspacePermissions = new Set<Permission>();
  const sitePermissions = new Map<
    string,
    { site: { id: string; name: string } | null; permissions: Set<Permission> }
  >();

  for (const assignment of assignments) {
    if (assignment.siteId === null) {
      for (const permission of assignment.role.permissions) {
        workspacePermissions.add(permission as Permission);
      }
      continue;
    }

    const summary = sitePermissions.get(assignment.siteId) ?? {
      site: assignment.site,
      permissions: new Set<Permission>(),
    };
    for (const permission of assignment.role.permissions) {
      summary.permissions.add(permission as Permission);
    }
    sitePermissions.set(assignment.siteId, summary);
  }

  const roles = assignments
    .filter((assignment) => assignment.siteId === null)
    .map((assignment) => ({
      id: assignment.role.id,
      name: assignment.role.name,
      isSystem: assignment.role.isSystem,
    }));

  const sitePermissionSummaries = [...sitePermissions.entries()].map(([siteId, summary]) => ({
    siteId,
    site: summary.site,
    permissions: sortPermissions(summary.permissions),
  }));

  const allSites = workspacePermissions.has("facility:read");
  const siteIds = allSites
    ? []
    : [
        ...new Set([
          ...sitePermissionSummaries
            .filter((summary) => summary.permissions.includes("facility:read"))
            .map((summary) => summary.siteId),
          // A workcenter grant confers facility:read at its site, so
          // grant-only members surface under their plant in the UI.
          ...workcenterGrants.map((grantRow) => grantRow.workcenter.siteId),
        ]),
      ];

  return {
    roles,
    roleAssignments: assignments.map((assignment) => ({
      id: assignment.id,
      siteId: assignment.siteId,
      site: assignment.site,
      role: assignment.role,
    })),
    workcenterGrants: workcenterGrants.map((grantRow) => ({
      id: grantRow.id,
      workcenterId: grantRow.workcenterId,
      access: grantRow.access,
      workcenter: grantRow.workcenter,
    })),
    access: {
      workspacePermissions: sortPermissions(workspacePermissions),
      sitePermissions: sitePermissionSummaries,
      sites: { all: allSites, siteIds },
    },
  };
}

export async function getWorkspaceAccessSummaries(
  userId: string,
  workspaceIds: string[],
): Promise<Map<string, WorkspaceAccessSummary>> {
  const memberships = workspaceIds.length
    ? await prisma.workspaceMembership.findMany({
        where: { userId, workspaceId: { in: workspaceIds } },
        select: {
          workspaceId: true,
          roleAssignments: {
            include: {
              site: { select: { id: true, name: true } },
              role: {
                select: {
                  id: true,
                  name: true,
                  isSystem: true,
                  scope: true,
                  permissions: true,
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
          workcenterGrants: {
            include: { workcenter: { select: { id: true, name: true, siteId: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      })
    : [];

  const byWorkspace = new Map<string, (typeof memberships)[number]>();
  for (const membership of memberships) {
    byWorkspace.set(membership.workspaceId, membership);
  }

  return new Map(
    workspaceIds.map((workspaceId) => {
      const membership = byWorkspace.get(workspaceId);
      return [
        workspaceId,
        buildWorkspaceAccessSummary(membership?.roleAssignments ?? [], membership?.workcenterGrants ?? []),
      ];
    }),
  );
}

/**
 * Add a user to a workspace and grant them the given workspace-scoped role.
 *
 * `roleId` must point at a Role with scope=WORKSPACE that belongs to this
 * workspace. RoleAssignment rows belong to the WorkspaceMembership and are the
 * source of truth for authority.
 */
export async function addMember(workspaceId: string, userId: string, roleId: string) {
  const role = await resolveWorkspaceRole(workspaceId, roleId);

  return prisma.$transaction(async (tx) => {
    const member = await tx.workspaceMembership.create({
      data: { workspaceId, userId },
      include: {
        user: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        workspace: {
          select: { id: true, name: true, slug: true },
        },
      },
    });

    await tx.roleAssignment.create({
      data: { membershipId: member.id, roleId: role.id, siteId: null },
    });

    return member;
  });
}

export type RemoveMemberError = "MEMBER_NOT_FOUND" | "LAST_OWNER";

export async function removeMember(
  workspaceId: string,
  userId: string,
  opts?: { actorId?: string; ipAddress?: string; userAgent?: string },
): Promise<{ success: true } | { success: false; error: RemoveMemberError }> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: {
      id: true,
      user: { select: { id: true, email: true, status: true } },
      roleAssignments: {
        where: { siteId: null },
        select: { role: { select: { isSystem: true, scope: true, permissions: true } } },
      },
    },
  });

  if (!membership) {
    return { success: false, error: "MEMBER_NOT_FOUND" };
  }

  // Removing the last owner would strand the workspace (same guard as
  // updateRole).
  const targetIsOwner = membership.roleAssignments.some((assignment) => isOwnerRole(assignment.role));
  if (targetIsOwner) {
    const remainingOwner = await prisma.workspaceMembership.findFirst({
      where: {
        workspaceId,
        userId: { not: userId },
        user: { status: "ACTIVE", systemRole: null },
        roleAssignments: {
          some: {
            siteId: null,
            role: {
              isSystem: true,
              scope: "WORKSPACE",
              permissions: { has: OWNER_PERMISSION },
            },
          },
        },
      },
      select: { id: true },
    });
    if (!remainingOwner) {
      return { success: false, error: "LAST_OWNER" };
    }
  }

  // A pending invitee whose only membership this is has never had an account
  // outside the invite - removing them here is revoking the invite, so delete
  // the user entirely and free the email for re-invites.
  if (membership.user.status === "PENDING") {
    const otherMemberships = await prisma.workspaceMembership.count({
      where: { userId, workspaceId: { not: workspaceId } },
    });
    if (otherMemberships === 0) {
      await prisma.user.delete({ where: { id: userId } });
      await logEvent({
        action: "INVITE_REVOKED",
        userId,
        actorId: opts?.actorId,
        workspaceId,
        ipAddress: opts?.ipAddress,
        userAgent: opts?.userAgent,
        metadata: { email: membership.user.email, via: "removeMember" },
      });
      return { success: true };
    }
  }

  await prisma.workspaceMembership.delete({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  return { success: true };
}

export type RemoveSiteAccessError = "MEMBER_NOT_FOUND" | "NO_SITE_ACCESS" | "LAST_OWNER";

/**
 * Remove a member's access to a single site by deleting their site-scoped
 * role assignments there. If that would leave the membership with no role
 * assignments at all, the whole membership is removed instead (an orphaned
 * membership is invisible in every members view and, for ACTIVE users,
 * unrecoverable — invites reject existing ACTIVE emails). Owner roles are
 * workspace-scoped (siteId null) assignments, so they always survive a
 * site-only removal and the cascade can never hit an owner.
 */
export async function removeSiteAccess(
  workspaceId: string,
  userId: string,
  siteId: string,
  opts?: { actorId?: string; ipAddress?: string; userAgent?: string },
): Promise<{ success: true; membershipRemoved: boolean } | { success: false; error: RemoveSiteAccessError }> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: {
      id: true,
      roleAssignments: { select: { id: true, siteId: true } },
      workcenterGrants: { select: { id: true, workcenter: { select: { siteId: true } } } },
    },
  });

  if (!membership) {
    return { success: false, error: "MEMBER_NOT_FOUND" };
  }

  const siteAssignments = membership.roleAssignments.filter((assignment) => assignment.siteId === siteId);
  const siteGrants = membership.workcenterGrants.filter((grantRow) => grantRow.workcenter.siteId === siteId);
  if (siteAssignments.length === 0 && siteGrants.length === 0) {
    return { success: false, error: "NO_SITE_ACCESS" };
  }

  const remaining =
    membership.roleAssignments.length -
    siteAssignments.length +
    membership.workcenterGrants.length -
    siteGrants.length;
  if (remaining === 0) {
    // Membership grants cascade-delete with the membership row.
    const result = await removeMember(workspaceId, userId, opts);
    if (!result.success) {
      return result;
    }
    return { success: true, membershipRemoved: true };
  }

  await prisma.$transaction([
    prisma.roleAssignment.deleteMany({ where: { membershipId: membership.id, siteId } }),
    prisma.workcenterGrant.deleteMany({ where: { membershipId: membership.id, workcenter: { siteId } } }),
  ]);
  return { success: true, membershipRemoved: false };
}

/**
 * Replace a member's role assignment in the caller's IAM context.
 * Workspace roles replace only the workspace-scoped assignment; site roles
 * replace only the assignment for the caller's current site.
 */
export async function updateRole(input: UpdateRoleInput): Promise<UpdateRoleResult> {
  const siteId = input.siteId;
  const role = await prisma.role.findUnique({ where: { id: input.roleId } });

  if (!role) return updateRoleError("ROLE_NOT_FOUND", `Role ${input.roleId} not found`);
  if (role.workspaceId !== input.workspaceId) {
    return updateRoleError("ROLE_WORKSPACE_MISMATCH", `Role ${input.roleId} does not belong to this workspace`);
  }
  if (hasReservedOwnerPermission(role)) {
    return updateRoleError("OWNER_PERMISSION_RESERVED", `${OWNER_PERMISSION} is reserved for workspace system roles`);
  }
  if (role.scope === "SITE" && !siteId) {
    return updateRoleError("SITE_CONTEXT_REQUIRED", "Site context is required to assign a site role");
  }

  const permissionContext =
    role.scope === "SITE" ? { workspaceId: input.workspaceId, siteId } : { workspaceId: input.workspaceId };

  const canAssignRoles = await hasAnyPermission(input.actorUserId, USER_ROLE_ASSIGNMENT_PERMISSIONS, permissionContext);

  if (!canAssignRoles) {
    return updateRoleError("FORBIDDEN", "Missing user-management permission");
  }

  const actorHasOwnerPermission = await hasPermission(input.actorUserId, OWNER_PERMISSION, {
    workspaceId: input.workspaceId,
  });
  const targetIsOwnerRole = isOwnerRole(role);

  if (targetIsOwnerRole && !actorHasOwnerPermission) {
    return updateRoleError("OWNER_PERMISSION_REQUIRED", `Missing permission: ${OWNER_PERMISSION}`);
  }

  return prisma.$transaction(
    async (tx) => {
      if (role.scope === "SITE") {
        const site = await tx.site.findUnique({
          where: { id: siteId },
          select: { workspaceId: true },
        });
        if (!site) return updateRoleError("SITE_NOT_FOUND", "Site not found");
        if (site.workspaceId !== input.workspaceId) {
          return updateRoleError("SITE_WORKSPACE_MISMATCH", "Site does not belong to this workspace");
        }
      }

      const membership = await tx.workspaceMembership.findUnique({
        where: {
          userId_workspaceId: {
            userId: input.targetUserId,
            workspaceId: input.workspaceId,
          },
        },
        select: { id: true },
      });
      if (!membership) return updateRoleError("MEMBER_NOT_FOUND", "Member not found");

      const assignmentSiteId = role.scope === "SITE" ? siteId : null;
      const currentAssignments = await tx.roleAssignment.findMany({
        where: { membershipId: membership.id, siteId: assignmentSiteId },
        include: { role: true },
      });
      const currentHasOwnerRole = currentAssignments.some((assignment) => isOwnerRole(assignment.role));

      if (currentHasOwnerRole && !actorHasOwnerPermission) {
        return updateRoleError("OWNER_PERMISSION_REQUIRED", `Missing permission: ${OWNER_PERMISSION}`);
      }

      if (currentHasOwnerRole && !targetIsOwnerRole) {
        const remainingOwner = await tx.workspaceMembership.findFirst({
          where: {
            workspaceId: input.workspaceId,
            userId: { not: input.targetUserId },
            user: { status: "ACTIVE", systemRole: null },
            roleAssignments: {
              some: {
                siteId: null,
                role: {
                  isSystem: true,
                  scope: "WORKSPACE",
                  permissions: { has: OWNER_PERMISSION },
                },
              },
            },
          },
          select: { id: true },
        });
        if (!remainingOwner) {
          return updateRoleError("LAST_OWNER", "Cannot remove the last workspace owner");
        }
      }

      await tx.roleAssignment.deleteMany({
        where: { membershipId: membership.id, siteId: assignmentSiteId },
      });
      await tx.roleAssignment.create({
        data: {
          membershipId: membership.id,
          roleId: role.id,
          siteId: assignmentSiteId,
        },
      });

      const updated = await tx.workspaceMembership.findUniqueOrThrow({
        where: { id: membership.id },
        include: {
          user: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      });

      return {
        success: true as const,
        data: updated as { [x: string]: unknown },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function resolveWorkspaceRole(workspaceId: string, roleId: string): Promise<Role> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new Error(`Role ${roleId} not found`);
  if (role.workspaceId !== workspaceId) {
    throw new Error(`Role ${roleId} does not belong to workspace ${workspaceId}`);
  }
  if (role.scope !== "WORKSPACE") {
    throw new Error(`Role ${roleId} is site-scoped; cannot be assigned as workspace membership`);
  }
  return role;
}

export async function listMembers(workspaceId: string) {
  // Defense in depth — system users can't hold WorkspaceMembership rows per the
  // RBAC invariants, but we filter them here regardless.
  const members = await prisma.workspaceMembership.findMany({
    where: { workspaceId, user: { systemRole: null } },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          status: true,
          lastLoginAt: true,
          invitedBy: true,
          invitedAt: true,
          inviteTokenExpiry: true,
          mustChangePassword: true,
        },
      },
      roleAssignments: {
        include: {
          site: { select: { id: true, name: true } },
          role: {
            select: {
              id: true,
              name: true,
              isSystem: true,
              scope: true,
              permissions: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
      workcenterGrants: {
        include: { workcenter: { select: { id: true, name: true, siteId: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  return members.map((m) => {
    const { inviteTokenExpiry, ...userRest } = m.user;
    return {
      ...m,
      user: { ...userRest, inviteExpiry: inviteTokenExpiry },
      roles: m.roleAssignments.map((assignment) => assignment.role),
    };
  });
}

export async function getUserWorkspaces(userId: string): Promise<WorkspaceMembership[]> {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { userId },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true, description: true },
      },
      employee: {
        select: {
          id: true,
          status: true,
          version: {
            select: {
              id: true,
              version: true,
              firstName: true,
              lastName: true,
              employeeNumber: true,
              badgeNumber: true,
            },
          },
        },
      },
      roleAssignments: {
        include: {
          site: { select: { id: true, name: true } },
          role: {
            select: {
              id: true,
              name: true,
              isSystem: true,
              scope: true,
              permissions: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
      workcenterGrants: {
        include: { workcenter: { select: { id: true, name: true, siteId: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  return memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    description: m.workspace.description,
    joinedAt: m.joinedAt,
    employee: m.employee,
    ...buildWorkspaceAccessSummary(m.roleAssignments, m.workcenterGrants),
  }));
}

export async function getUserAccess(workspaceId: string, userId: string) {
  return prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
}

export async function isMember(workspaceId: string, userId: string): Promise<boolean> {
  const membership = await getUserAccess(workspaceId, userId);
  return !!membership;
}

export async function countMembers(workspaceId: string): Promise<number> {
  return prisma.workspaceMembership.count({ where: { workspaceId } });
}

/**
 * Look up a seeded workspace-scoped system role by name in a workspace.
 */
export async function findSystemRoleOrThrow(workspaceId: string, name: "Company Administrator"): Promise<Role> {
  const role = await findSystemRole(workspaceId, name, "WORKSPACE");
  if (!role) {
    throw new Error(`System role "${name}" missing for workspace ${workspaceId}`);
  }
  return role;
}
