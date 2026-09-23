import prisma from "@rw/db";
import { securityConfig } from "../../../config.js";
import type { Tier as BucketTier, UserAccess } from "@rw/auth/iam/access";
import { hashPassword } from "@rw/auth/password";
import { sendInviteEmail } from "@rw/services/email/index";
import { logEvent } from "@rw/services/audit/index";
import { generateStrongPassword } from "./password.js";
import { adminAt, checkBuckets, writeAccesses } from "../workspace/members.js";

export interface CreateInviteInput {
  email: string;
  inviterId: string;
  /** The inviter's access: ADMIN at each granted plant, owner to invite owners. */
  actor: UserAccess;
  workspaceId: string;
  context?: InviteContext;
  /**
   * Bucket accesses for new invitees (and adoptions of orphaned pending
   * users). New invites need bucketAccesses or asOwner; resending an
   * existing pending invite needs neither.
   */
  bucketAccesses?: Array<{ bucketId: string; tier: BucketTier }>;
  /** Invite as workspace owner — reserved; only an owner may do this. */
  asOwner?: boolean;
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

interface ResolvedInviteAccess {
  accesses: Array<{ bucketId: string; tier: BucketTier; siteId: string | null }>;
  asOwner: boolean;
}

/** Resolve and validate the invite's access: bucket accesses, ownership, or both. */
async function resolveInviteAccess(input: {
  workspaceId: string;
  bucketAccesses?: Array<{ bucketId: string; tier: BucketTier }>;
  asOwner?: boolean;
}): Promise<{ ok: true; access: ResolvedInviteAccess } | { ok: false; error: string }> {
  const wanted = input.bucketAccesses ?? [];
  if (wanted.length === 0 && !input.asOwner) {
    return { ok: false, error: "bucketAccesses or asOwner is required" };
  }
  const check = await checkBuckets(
    input.workspaceId,
    wanted.map((a) => a.bucketId),
    wanted,
  );
  if (!check.ok) return { ok: false, error: check.error };
  const accesses = wanted.map((a) => ({ ...a, siteId: check.buckets.get(a.bucketId)?.siteId ?? null }));
  return { ok: true, access: { accesses, asOwner: input.asOwner === true } };
}

/** Handing out ownership is the owner's alone; buckets need ADMIN at their plant. */
function canInviteAccess(actor: UserAccess, access: ResolvedInviteAccess): boolean {
  if (access.asOwner && !actor.person.owner) return false;
  return access.accesses.every((a) => adminAt(actor, a.siteId));
}

/**
 * Resend/revoke authority: ADMIN at any site the pending member has access
 * at; owner-memberships are owner-managed only.
 */
function canManagePendingInvite(
  actor: UserAccess,
  target: { workspaceRole: string; accessSiteIds: Array<string | null> },
): boolean {
  if (target.workspaceRole === "OWNER") return actor.person.owner;
  const siteIds = target.accessSiteIds.filter((s): s is string => s !== null);
  // Orphaned invite with no access context — plant admins may clean up.
  if (siteIds.length === 0) return actor.canSomewhere("ADMIN");
  return siteIds.some((siteId) => adminAt(actor, siteId));
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
  let auditAccess: {
    asOwner?: boolean;
    bucketAccesses?: Array<{ bucketId: string; tier: string }>;
  } = {};

  const auditFromAccess = (access: ResolvedInviteAccess): typeof auditAccess => ({
    ...(access.asOwner ? { asOwner: true } : {}),
    ...(access.accesses.length
      ? { bucketAccesses: access.accesses.map((a) => ({ bucketId: a.bucketId, tier: a.tier })) }
      : {}),
  });

  if (existingUser) {
    // PENDING user — either a straight resend or adoption of an orphan
    // (missing membership, or zero bucket accesses and not an owner: the
    // states the old flow left permanently uninvitable).
    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: existingUser.id, workspaceId } },
      select: {
        id: true,
        workspaceRole: true,
        bucketAccesses: { select: { bucket: { select: { siteId: true } } } },
      },
    });

    if (membership && (membership.bucketAccesses.length > 0 || membership.workspaceRole === "OWNER")) {
      mode = "resent";
      // Resend refreshes invite delivery only. Access changes are explicit
      // member-management actions and are not hidden in resend.
      const canResend = canManagePendingInvite(input.actor, {
        workspaceRole: membership.workspaceRole,
        accessSiteIds: membership.bucketAccesses.map((a) => a.bucket.siteId),
      });
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

      if (!canInviteAccess(input.actor, access)) {
        return { success: false, error: "Forbidden" };
      }
      auditAccess = auditFromAccess(access);

      try {
        user = await prisma.$transaction(async (tx) => {
          const updated = await tx.user.update({
            where: { id: existingUser.id },
            data: inviteCredentialData,
            select: { id: true, email: true, status: true, firstName: true, lastName: true },
          });

          const adoptedMembership = await tx.workspaceMembership.upsert({
            where: { userId_workspaceId: { userId: existingUser.id, workspaceId } },
            update: { ...(access.asOwner ? { workspaceRole: "OWNER" as const } : {}) },
            create: {
              workspaceId,
              userId: existingUser.id,
              ...(access.asOwner ? { workspaceRole: "OWNER" as const } : {}),
            },
            select: { id: true },
          });

          await writeAccesses(tx, adoptedMembership.id, access.accesses);

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

    if (!canInviteAccess(input.actor, access)) {
      return { success: false, error: "Forbidden" };
    }
    auditAccess = auditFromAccess(access);

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
          data: {
            workspaceId,
            userId: createdUser.id,
            ...(access.asOwner ? { workspaceRole: "OWNER" as const } : {}),
          },
          select: { id: true },
        });

        await writeAccesses(tx, membership.id, access.accesses);

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
      ...auditAccess,
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
  actor: UserAccess;
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
          workspaceRole: true,
          bucketAccesses: { select: { bucket: { select: { siteId: true } } } },
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

  const canRevoke = canManagePendingInvite(input.actor, {
    workspaceRole: target.memberships[0].workspaceRole,
    accessSiteIds: target.memberships[0].bucketAccesses.map((a) => a.bucket.siteId),
  });
  if (!canRevoke) {
    return { success: false, error: "FORBIDDEN" };
  }

  // Memberships, bucket accesses, and refresh tokens all cascade
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
