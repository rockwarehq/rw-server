import prisma from "@rw/db";
import { securityConfig } from "../../../config.js";
import { hasOwnerPermission, hasPermission, OWNER_PERMISSION } from "@rw/auth/iam/index";
import { hashPassword } from "@rw/auth/password";
import { sendInviteEmail } from "@rw/services/email/index";
import { logEvent } from "@rw/services/audit/index";
import { generateStrongPassword } from "./password.js";

export interface CreateInviteInput {
  email: string;
  inviterId: string;
  workspaceId: string;
  context?: InviteContext;
  /**
   * Role id to assign to new invitees. New invites (and adoptions of
   * orphaned pending users) need a roleId, workcenterGrants, or both;
   * resending an existing pending invite needs neither. Workspace roles
   * assign at workspace scope; site roles assign to `siteId` or the
   * caller's site fallback.
   */
  roleId?: string;
  siteId?: string;
  fallbackSiteId?: string;
  /** Workcenter grants to create for the invitee (GitHub-collaborator style). */
  workcenterGrants?: Array<{ workcenterId: string; access: "READ" | "WRITE" }>;
  firstName?: string;
  lastName?: string;
  /** Validated http(s) origin of the inviting client, used in the email link. */
  appUrl?: string;
}

export interface InviteResult {
  [x: string]: unknown;
  user: {
    [x: string]: unknown;
    id: string;
    email: string;
    status: string;
    firstName: string | null;
    lastName: string | null;
  };
  /** Returned once so the admin can relay it; never persisted in plaintext. */
  temporaryPassword: string;
  expiresAt: Date;
  emailSent: boolean;
}

export interface InviteContext {
  ipAddress?: string;
  userAgent?: string;
}

interface InviteAssignment {
  roleId: string;
  siteId: string | null;
  scope: "WORKSPACE" | "SITE";
  isOwner: boolean;
}

interface InviteGrant {
  workcenterId: string;
  siteId: string;
  access: "READ" | "WRITE";
}

interface InviteAccess {
  assignment: InviteAssignment | null;
  grants: InviteGrant[];
}

/** Resolve and validate the invite's access: a role, workcenter grants, or both. */
async function resolveInviteAccess(input: {
  workspaceId: string;
  roleId?: string;
  siteId?: string;
  fallbackSiteId?: string;
  workcenterGrants?: Array<{ workcenterId: string; access: "READ" | "WRITE" }>;
}): Promise<{ ok: true; access: InviteAccess } | { ok: false; error: string }> {
  const grantInputs = input.workcenterGrants ?? [];
  if (!input.roleId && grantInputs.length === 0) {
    return { ok: false, error: "roleId or workcenterGrants is required" };
  }

  let assignment: InviteAssignment | null = null;
  if (input.roleId) {
    const resolved = await resolveInviteAssignment(input);
    if (!resolved.ok) return resolved;
    assignment = resolved.assignment;
  }

  const grants: InviteGrant[] = [];
  for (const grantInput of grantInputs) {
    const workcenter = await prisma.workcenter.findUnique({
      where: { id: grantInput.workcenterId },
      select: { id: true, site: { select: { id: true, workspaceId: true } } },
    });
    if (!workcenter) return { ok: false, error: "Workcenter not found" };
    if (workcenter.site.workspaceId !== input.workspaceId) {
      return { ok: false, error: "Workcenter does not belong to this workspace" };
    }
    grants.push({ workcenterId: workcenter.id, siteId: workcenter.site.id, access: grantInput.access });
  }

  return { ok: true, access: { assignment, grants } };
}

async function resolveInviteAssignment(input: {
  workspaceId: string;
  roleId?: string;
  siteId?: string;
  fallbackSiteId?: string;
}): Promise<{ ok: true; assignment: InviteAssignment } | { ok: false; error: string }> {
  if (!input.roleId) {
    return { ok: false, error: "roleId is required" };
  }

  const role = await prisma.role.findUnique({
    where: { id: input.roleId },
    select: { id: true, name: true, scope: true, workspaceId: true, isSystem: true, permissions: true },
  });
  if (!role) return { ok: false, error: "Role not found" };
  if (role.workspaceId !== input.workspaceId) {
    return { ok: false, error: "Role does not belong to this workspace" };
  }

  const isOwner = hasOwnerPermission(role.permissions);
  if (isOwner && (!role.isSystem || role.scope !== "WORKSPACE")) {
    return { ok: false, error: `${OWNER_PERMISSION} is reserved for workspace system roles` };
  }

  if (role.scope === "WORKSPACE") {
    if (input.siteId) {
      return { ok: false, error: "siteId cannot be used with a workspace-scoped role" };
    }
    return { ok: true, assignment: { roleId: role.id, siteId: null, scope: "WORKSPACE", isOwner } };
  }

  const siteId = input.siteId ?? input.fallbackSiteId;
  if (!siteId) {
    return { ok: false, error: "siteId is required for site-scoped invite roles" };
  }

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { workspaceId: true },
  });
  if (!site) return { ok: false, error: "Site not found" };
  if (site.workspaceId !== input.workspaceId) {
    return { ok: false, error: "Site does not belong to this workspace" };
  }

  return { ok: true, assignment: { roleId: role.id, siteId, scope: "SITE", isOwner: false } };
}

async function canInviteAssignment(inviterId: string, workspaceId: string, assignment: InviteAssignment) {
  if (assignment.isOwner) {
    return hasPermission(inviterId, OWNER_PERMISSION, { workspaceId });
  }

  return hasPermission(inviterId, "user:write", {
    workspaceId,
    ...(assignment.siteId ? { siteId: assignment.siteId } : {}),
  });
}

async function canInviteAccess(inviterId: string, workspaceId: string, access: InviteAccess): Promise<boolean> {
  if (access.assignment && !(await canInviteAssignment(inviterId, workspaceId, access.assignment))) {
    return false;
  }
  // Every granted workcenter's site needs the inviter to hold user:write.
  for (const grantRow of access.grants) {
    const ok = await hasPermission(inviterId, "user:write", { workspaceId, siteId: grantRow.siteId });
    if (!ok) return false;
  }
  return true;
}

type ExistingAssignment = { siteId: string | null; role: { permissions: string[] } };

async function canManagePendingInvite(
  actorId: string,
  workspaceId: string,
  assignments: ExistingAssignment[],
  grantSiteIds: string[] = [],
): Promise<boolean> {
  if (assignments.length === 0 && grantSiteIds.length === 0) {
    // Orphaned invite with no role context - require workspace-level rights
    return hasPermission(actorId, "user:write", { workspaceId });
  }

  if (assignments.some((assignment) => hasOwnerPermission(assignment.role.permissions))) {
    return hasPermission(actorId, OWNER_PERMISSION, { workspaceId });
  }

  for (const assignment of assignments) {
    const ok = await hasPermission(actorId, "user:write", {
      workspaceId,
      ...(assignment.siteId ? { siteId: assignment.siteId } : {}),
    });
    if (ok) return true;
  }
  for (const siteId of grantSiteIds) {
    const ok = await hasPermission(actorId, "user:write", { workspaceId, siteId });
    if (ok) return true;
  }

  return false;
}

async function inviteEmailContext(inviterId: string, workspaceId: string) {
  const [inviter, workspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: inviterId }, select: { firstName: true, lastName: true } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
  ]);

  return {
    inviterName: inviter ? [inviter.firstName, inviter.lastName].filter(Boolean).join(" ") || undefined : undefined,
    workspaceName: workspace?.name,
  };
}

export async function createInvite(
  input: CreateInviteInput,
): Promise<{ success: true; data: InviteResult } | { success: false; error: string }> {
  const { email, inviterId, workspaceId, context } = input;

  const normalizedEmail = email.toLowerCase();

  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existingUser?.systemRole) {
    return { success: false, error: "Cannot invite a system user to a workspace" };
  }
  if (existingUser?.status === "ACTIVE") {
    return { success: false, error: "User with this email already exists" };
  }
  if (existingUser?.status === "DISABLED") {
    return { success: false, error: "User is disabled" };
  }

  const temporaryPassword = generateStrongPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const expiresAt = new Date(Date.now() + securityConfig.inviteExpiryMs);

  // Fresh credential supersedes stale lockout state, same as an admin reset
  const inviteCredentialData = {
    passwordHash,
    mustChangePassword: true,
    inviteTokenExpiry: expiresAt,
    invitedBy: inviterId,
    invitedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    ...(input.firstName !== undefined ? { firstName: input.firstName.trim() || null } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName.trim() || null } : {}),
  };

  let user: { id: string; email: string; status: string; firstName: string | null; lastName: string | null };
  let mode: "resent" | "adopted" | "new";
  let auditAssignment: {
    roleId?: string;
    siteId?: string | null;
    workcenterGrants?: Array<{ workcenterId: string; access: string }>;
  } = {};

  const auditFromAccess = (access: InviteAccess): typeof auditAssignment => ({
    ...(access.assignment ? { roleId: access.assignment.roleId, siteId: access.assignment.siteId } : {}),
    ...(access.grants.length
      ? { workcenterGrants: access.grants.map((g) => ({ workcenterId: g.workcenterId, access: g.access })) }
      : {}),
  });

  if (existingUser) {
    // PENDING user - either a straight resend or adoption of an orphan
    // (missing membership, or zero role assignments AND zero workcenter
    // grants - the states the old flow left permanently uninvitable).
    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: existingUser.id, workspaceId } },
      select: {
        id: true,
        roleAssignments: {
          select: { siteId: true, role: { select: { permissions: true } } },
        },
        workcenterGrants: {
          select: { workcenter: { select: { siteId: true } } },
        },
      },
    });

    if (membership && (membership.roleAssignments.length > 0 || membership.workcenterGrants.length > 0)) {
      mode = "resent";
      // Resend refreshes invite delivery only. Role/membership changes are
      // explicit member-management actions and are not hidden in resend.
      const canResend = await canManagePendingInvite(
        inviterId,
        workspaceId,
        membership.roleAssignments,
        membership.workcenterGrants.map((g) => g.workcenter.siteId),
      );
      if (!canResend) {
        return { success: false, error: "Forbidden" };
      }

      try {
        user = await prisma.user.update({
          where: { id: existingUser.id },
          data: inviteCredentialData,
          select: { id: true, email: true, status: true, firstName: true, lastName: true },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not create invite";
        return { success: false, error: message };
      }
    } else {
      mode = "adopted";
      const resolveResult = await resolveInviteAccess(input);
      if (!resolveResult.ok) {
        return { success: false, error: resolveResult.error };
      }
      const access = resolveResult.access;

      if (!(await canInviteAccess(inviterId, workspaceId, access))) {
        return { success: false, error: "Forbidden" };
      }
      auditAssignment = auditFromAccess(access);

      try {
        user = await prisma.$transaction(async (tx) => {
          const updated = await tx.user.update({
            where: { id: existingUser.id },
            data: inviteCredentialData,
            select: { id: true, email: true, status: true, firstName: true, lastName: true },
          });

          const adoptedMembership = await tx.workspaceMembership.upsert({
            where: { userId_workspaceId: { userId: existingUser.id, workspaceId } },
            update: {},
            create: { workspaceId, userId: existingUser.id },
            select: { id: true },
          });

          if (access.assignment) {
            await tx.roleAssignment.create({
              data: {
                membershipId: adoptedMembership.id,
                roleId: access.assignment.roleId,
                siteId: access.assignment.siteId,
              },
            });
          }
          for (const grantRow of access.grants) {
            await tx.workcenterGrant.upsert({
              where: {
                membershipId_workcenterId: {
                  membershipId: adoptedMembership.id,
                  workcenterId: grantRow.workcenterId,
                },
              },
              update: { access: grantRow.access },
              create: {
                membershipId: adoptedMembership.id,
                workcenterId: grantRow.workcenterId,
                access: grantRow.access,
              },
            });
          }

          return updated;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not create invite";
        return { success: false, error: message };
      }
    }
  } else {
    mode = "new";
    const resolveResult = await resolveInviteAccess(input);
    if (!resolveResult.ok) {
      return { success: false, error: resolveResult.error };
    }
    const access = resolveResult.access;

    if (!(await canInviteAccess(inviterId, workspaceId, access))) {
      return { success: false, error: "Forbidden" };
    }
    auditAssignment = auditFromAccess(access);

    try {
      user = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            email: normalizedEmail,
            status: "PENDING",
            ...inviteCredentialData,
          },
          select: { id: true, email: true, status: true, firstName: true, lastName: true },
        });

        const membership = await tx.workspaceMembership.create({
          data: { workspaceId, userId: createdUser.id },
          select: { id: true },
        });

        if (access.assignment) {
          await tx.roleAssignment.create({
            data: { membershipId: membership.id, roleId: access.assignment.roleId, siteId: access.assignment.siteId },
          });
        }
        if (access.grants.length) {
          await tx.workcenterGrant.createMany({
            data: access.grants.map((grantRow) => ({
              membershipId: membership.id,
              workcenterId: grantRow.workcenterId,
              access: grantRow.access,
            })),
          });
        }

        return createdUser;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create invite";
      return { success: false, error: message };
    }
  }

  const { inviterName, workspaceName } = await inviteEmailContext(inviterId, workspaceId);

  const emailResult = await sendInviteEmail({
    to: normalizedEmail,
    temporaryPassword,
    appUrl: input.appUrl,
    inviterName,
    workspaceName,
    expiresInDays: Math.round(securityConfig.inviteExpiryMs / 86_400_000),
  });

  await logEvent({
    action: "USER_INVITED",
    userId: user.id,
    actorId: inviterId,
    workspaceId,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: {
      mode,
      emailSent: emailResult.success,
      ...auditAssignment,
    },
  });

  return {
    success: true,
    data: {
      user,
      temporaryPassword,
      expiresAt,
      emailSent: emailResult.success,
    },
  };
}

export type RevokeInviteError = "USER_NOT_FOUND" | "NOT_PENDING" | "SELF_REVOKE" | "SYSTEM_USER" | "FORBIDDEN";

export async function revokeInvite(input: {
  targetUserId: string;
  actorId: string;
  workspaceId: string;
  context?: InviteContext;
}): Promise<{ success: true } | { success: false; error: RevokeInviteError }> {
  const { targetUserId, actorId, workspaceId, context } = input;

  if (targetUserId === actorId) {
    return { success: false, error: "SELF_REVOKE" };
  }

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      email: true,
      status: true,
      systemRole: true,
      memberships: {
        where: { workspaceId },
        select: {
          id: true,
          roleAssignments: {
            select: { siteId: true, role: { select: { permissions: true } } },
          },
          workcenterGrants: {
            select: { workcenter: { select: { siteId: true } } },
          },
        },
      },
    },
  });

  // Unknown user and no-membership-here look the same, so one workspace
  // cannot enumerate or delete another workspace's invites.
  if (!target || target.memberships.length === 0) {
    return { success: false, error: "USER_NOT_FOUND" };
  }

  if (target.systemRole) {
    return { success: false, error: "SYSTEM_USER" };
  }

  if (target.status !== "PENDING") {
    return { success: false, error: "NOT_PENDING" };
  }

  const canRevoke = await canManagePendingInvite(
    actorId,
    workspaceId,
    target.memberships[0].roleAssignments,
    target.memberships[0].workcenterGrants.map((g) => g.workcenter.siteId),
  );
  if (!canRevoke) {
    return { success: false, error: "FORBIDDEN" };
  }

  // Memberships, role assignments, and refresh tokens all cascade
  await prisma.user.delete({ where: { id: target.id } });

  await logEvent({
    action: "INVITE_REVOKED",
    userId: target.id,
    actorId,
    workspaceId,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: { email: target.email },
  });

  return { success: true };
}
