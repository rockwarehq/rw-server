import prisma from "@rw/db";
import { securityConfig } from "../config.js";
import { logEvent } from "@rw/services/audit/index";
import { comparePassword } from "@rw/auth/password";
import {
  createAccessToken,
  createRefreshToken,
  verifyRefreshToken,
  inspectRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  REFRESH_REUSE_GRACE_MS,
  type AccessTokenPayload,
} from "@rw/auth/tokens";
import { listAccessibleSites } from "@rw/auth/iam/index";

export interface LoginResult {
  [x: string]: unknown;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  user: {
    [x: string]: unknown;
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    mustChangePassword: boolean;
  };
}

export interface TokenPair {
  [x: string]: unknown;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface AuthContext {
  ipAddress?: string;
  userAgent?: string;
}

interface TokenUser {
  id: string;
  email: string;
  /** Rockware-staff tier (SUPPORT/ENGINEER): permissions resolve from code
   * and no WorkspaceMembership exists — workspace context comes from the
   * deployment's workspace instead. */
  systemRole?: string | null;
}

/**
 * System users hold no memberships by design: resolve their workspace
 * context directly (requested workspace when valid, else the deployment's
 * default/oldest workspace).
 */
async function resolveSystemUserWorkspaceId(requestedWorkspaceId?: string): Promise<string | null> {
  if (requestedWorkspaceId) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: requestedWorkspaceId },
      select: { id: true },
    });
    return workspace?.id ?? null;
  }
  const workspace = await prisma.workspace.findFirst({
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  return workspace?.id ?? null;
}

async function createUserAccessTokenForContext(
  user: TokenUser,
  options: { workspaceId?: string; siteId?: string } = {},
): Promise<{ success: true; accessToken: string; workspaceId: string } | { success: false; error: string }> {
  let workspaceId: string | null;
  if (user.systemRole) {
    workspaceId = await resolveSystemUserWorkspaceId(options.workspaceId);
    if (!workspaceId) {
      return { success: false, error: "Workspace not found" };
    }
  } else {
    const membership = options.workspaceId
      ? await prisma.workspaceMembership.findUnique({
          where: {
            userId_workspaceId: {
              userId: user.id,
              workspaceId: options.workspaceId,
            },
          },
          select: { workspaceId: true },
        })
      : await prisma.workspaceMembership.findFirst({
          where: { userId: user.id },
          select: { workspaceId: true },
          orderBy: { joinedAt: "asc" },
        });

    if (!membership) {
      return { success: false, error: "User is not assigned to a workspace" };
    }
    workspaceId = membership.workspaceId;
  }

  const tokenPayload: AccessTokenPayload = {
    id: user.id,
    email: user.email,
  };

  tokenPayload.workspaceId = workspaceId;

  const sites = await listAccessibleSites(user.id, workspaceId);
  if (options.siteId) {
    const site = sites.find((item) => item.id === options.siteId);
    if (!site) {
      return { success: false, error: "Not authorized for this site" };
    }
    tokenPayload.siteId = site.id;
  } else if (sites.length > 0) {
    tokenPayload.siteId = sites[0].id;
  }

  return {
    success: true,
    accessToken: createAccessToken(tokenPayload),
    workspaceId,
  };
}

export async function login(
  email: string,
  password: string,
  metadata?: { userAgent?: string; ipAddress?: string },
): Promise<{ success: true; data: LoginResult } | { success: false; error: string }> {
  const context: AuthContext = {
    ipAddress: metadata?.ipAddress,
    userAgent: metadata?.userAgent,
  };

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  // Don't reveal if user exists
  if (!user) {
    return { success: false, error: "Invalid email or password" };
  }

  // Check if account is locked
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutesRemaining = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);

    await logEvent({
      action: "LOGIN_LOCKED",
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { minutesRemaining },
    });
    return {
      success: false,
      error: `Account is temporarily locked. Try again in ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"}.`,
    };
  }

  if (user.status === "DISABLED") {
    await logEvent({
      action: "LOGIN_FAILED",
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { reason: "account_disabled" },
    });
    return { success: false, error: "Account is disabled" };
  }

  // PENDING users WITH a password are invitees mid-activation - they may log
  // in (the mustChangePassword gate boxes them in until they set their own).
  if (!user.passwordHash) {
    await logEvent({
      action: "LOGIN_FAILED",
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { reason: "no_password_set" },
    });
    return { success: false, error: "Please complete your registration first" };
  }

  const passwordValid = await comparePassword(password, user.passwordHash);
  if (!passwordValid) {
    // Increment failed attempts
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const shouldLock = attempts >= securityConfig.maxLoginAttempts;
    const lockout = shouldLock ? new Date(Date.now() + securityConfig.loginLockoutMs) : null;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil: lockout,
      },
    });

    await logEvent({
      action: "LOGIN_FAILED",
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { reason: "invalid_password", attempts, locked: shouldLock },
    });

    if (shouldLock) {
      const lockMinutes = Math.ceil(securityConfig.loginLockoutMs / 60000);
      return {
        success: false,
        error: `Too many failed attempts. Account locked for ${lockMinutes} minutes.`,
      };
    }

    return { success: false, error: "Invalid email or password" };
  }

  // Checked only after a successful password compare so outsiders cannot
  // probe which emails hold pending invites.
  if (user.status === "PENDING" && user.inviteTokenExpiry && user.inviteTokenExpiry < new Date()) {
    await logEvent({
      action: "INVITE_EXPIRED",
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { reason: "login_after_expiry" },
    });
    return { success: false, error: "Invite has expired. Ask an administrator to resend the invite." };
  }

  const tokenResult = await createUserAccessTokenForContext(user);
  if (!tokenResult.success) return { success: false, error: tokenResult.error };
  const { token: refreshToken, expiresAt } = await createRefreshToken(user.id, metadata);

  // Update user: reset failed attempts and update last login
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });

  await logEvent({
    action: "LOGIN_SUCCESS",
    userId: user.id,
    workspaceId: tokenResult.workspaceId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return {
    success: true,
    data: {
      accessToken: tokenResult.accessToken,
      refreshToken,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        mustChangePassword: user.mustChangePassword,
      },
    },
  };
}

export async function logout(refreshToken: string, context?: AuthContext): Promise<boolean> {
  // Get user ID from token before revoking
  const verification = await verifyRefreshToken(refreshToken);
  const userId = verification.userId;

  const revoked = await revokeRefreshToken(refreshToken);

  if (revoked && userId) {
    await logEvent({
      action: "LOGOUT",
      userId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
  }

  return revoked;
}

export async function logoutAll(userId: string, context?: AuthContext): Promise<number> {
  const count = await revokeAllUserRefreshTokens(userId);

  await logEvent({
    action: "LOGOUT",
    userId,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: { allSessions: true, sessionsRevoked: count },
  });

  return count;
}

export async function refreshSession(
  refreshToken: string,
  siteId?: string,
  metadata?: { userAgent?: string; ipAddress?: string },
): Promise<{ success: true; data: TokenPair } | { success: false; error: string }> {
  const inspection = await inspectRefreshToken(refreshToken);

  // Reuse detection with a grace interval: a rotated (revoked) token presented
  // again within REFRESH_REUSE_GRACE_MS is a benign re-presentation — a
  // rotation response lost to a deploy/restart, or two tabs sharing one token
  // refreshing concurrently — and refreshes normally (the row is already
  // revoked, so no re-revocation; the earlier replacement token stays valid
  // too). Reuse after the grace window signals theft: revoke the entire family
  // so neither the attacker nor the victim can continue, forcing a fresh login.
  // Only rotation revocations qualify (rotatedAt set): tokens revoked by
  // logout/logout-all/theft-response never refresh again, grace or not.
  const graceReuse =
    inspection.status === "revoked" &&
    inspection.rotatedAt !== undefined &&
    Date.now() - inspection.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS;

  if (inspection.status === "revoked" && inspection.userId && !graceReuse) {
    await revokeAllUserRefreshTokens(inspection.userId);
    await logEvent({
      action: "REFRESH_REUSE_DETECTED",
      userId: inspection.userId,
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
      metadata: { tokenId: inspection.tokenId, familyRevoked: true },
    });
    return { success: false, error: "Invalid or expired refresh token" };
  }

  if ((inspection.status !== "valid" && !graceReuse) || !inspection.userId) {
    return { success: false, error: "Invalid or expired refresh token" };
  }

  if (graceReuse) {
    await logEvent({
      action: "REFRESH_REUSE_GRACE",
      userId: inspection.userId,
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
      metadata: { tokenId: inspection.tokenId },
    });
  } else {
    // Revoke the old refresh token (rotation — eligible for the grace window)
    await revokeRefreshToken(refreshToken, { rotated: true });
  }

  const user = await prisma.user.findUnique({
    where: { id: inspection.userId },
  });

  if (!user || user.status !== "ACTIVE") {
    return { success: false, error: "User account is not active" };
  }

  // Check if account is locked
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { success: false, error: "Account is temporarily locked" };
  }

  const tokenResult = await createUserAccessTokenForContext(user, { siteId });
  if (!tokenResult.success) return { success: false, error: tokenResult.error };
  const { token: newRefreshToken, expiresAt } = await createRefreshToken(user.id, metadata);

  return {
    success: true,
    data: {
      accessToken: tokenResult.accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
    },
  };
}

export async function switchWorkspace(
  userId: string,
  workspaceId: string,
): Promise<{ success: true; data: { accessToken: string } } | { success: false; error: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user || user.status !== "ACTIVE") {
    return { success: false, error: "User account is not active" };
  }

  // Check if account is locked
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { success: false, error: "Account is temporarily locked" };
  }

  // System users hold no memberships: any existing workspace is switchable
  // (the token helper validates existence).
  if (!user.systemRole) {
    const membership = await prisma.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId,
        },
      },
    });

    if (!membership) {
      return { success: false, error: "Not a member of this workspace" };
    }
  }

  const tokenResult = await createUserAccessTokenForContext(user, {
    workspaceId,
  });
  if (!tokenResult.success) return { success: false, error: tokenResult.error };

  return {
    success: true,
    data: { accessToken: tokenResult.accessToken },
  };
}

export async function switchSite(
  userId: string,
  siteId: string,
): Promise<{ success: true; data: { accessToken: string } } | { success: false; error: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user || user.status !== "ACTIVE") {
    return { success: false, error: "User account is not active" };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { success: false, error: "Account is temporarily locked" };
  }

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { workspaceId: true },
  });
  if (!site) return { success: false, error: "Site not found" };

  const tokenResult = await createUserAccessTokenForContext(user, {
    workspaceId: site.workspaceId,
    siteId,
  });
  if (!tokenResult.success) return { success: false, error: tokenResult.error };

  return { success: true, data: { accessToken: tokenResult.accessToken } };
}
