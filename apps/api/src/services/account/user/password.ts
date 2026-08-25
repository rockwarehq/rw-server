import { randomInt } from "node:crypto";
import prisma from "@rw/db";
import { hashToken, safeEqual } from "@rw/auth/secrets";
import { hashPassword, comparePassword } from "@rw/auth/password";
import { hasPermission, OWNER_PERMISSION } from "@rw/auth/iam/index";
import { securityConfig } from "../../../config.js";
import { sendPasswordResetEmail } from "@rw/services/email/index";
import { logEvent } from "@rw/services/audit/index";
import { validatePasswordStrength } from "../../validation.js";
import { generateResetCode, normalizeResetCode } from "./reset-code.js";

export interface ResetRequestResult {
  email: string;
  expiresAt: Date;
  emailSent: boolean;
}

export interface ResetContext {
  ipAddress?: string;
  userAgent?: string;
}

export async function initiateReset(
  email: string,
  context?: ResetContext,
): Promise<{ success: true; data: ResetRequestResult } | { success: false; error: string }> {
  const normalizedEmail = email.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    // Don't reveal if user exists - return success message anyway
    // But don't log anything to avoid enumeration via audit logs
    return {
      success: true,
      data: {
        email: normalizedEmail,
        expiresAt: new Date(Date.now() + securityConfig.resetCodeExpiryMs),
        emailSent: false, // No email sent since user doesn't exist
      },
    };
  }

  if (user.status === "DISABLED") {
    // Log the attempt but return generic message
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "account_disabled" },
    });
    return {
      success: true,
      data: {
        email: normalizedEmail,
        expiresAt: new Date(Date.now() + securityConfig.resetCodeExpiryMs),
        emailSent: false,
      },
    };
  }

  // PENDING invitees WITH a temp password may reset - a code from their
  // mailbox proves address ownership. Only password-less rows are refused.
  if (user.status === "PENDING" && !user.passwordHash) {
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "registration_incomplete" },
    });
    return {
      success: true,
      data: {
        email: normalizedEmail,
        expiresAt: new Date(Date.now() + securityConfig.resetCodeExpiryMs),
        emailSent: false,
      },
    };
  }

  const { plaintext, hash } = generateResetCode();
  const resetTokenExpiry = new Date(Date.now() + securityConfig.resetCodeExpiryMs);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetTokenHash: hash,
      resetTokenExpiry,
      resetAttempts: 0, // Reset attempts on new request
    },
  });

  // Send password reset email
  const emailResult = await sendPasswordResetEmail({
    to: user.email,
    resetCode: plaintext,
    expiresInMinutes: Math.round(securityConfig.resetCodeExpiryMs / 60_000),
  });

  await logEvent({
    action: "PASSWORD_RESET_REQUESTED",
    userId: user.id,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: { emailSent: emailResult.success },
  });

  return {
    success: true,
    data: {
      email: user.email,
      expiresAt: resetTokenExpiry,
      emailSent: emailResult.success,
    },
  };
}

type CodeCheck = { ok: true; user: { id: string; email: string; status: string } } | { ok: false };

/**
 * Validate a reset code for an email. Every failure looks the same from the
 * outside; wrong codes count against the attempt cap so this can't be used
 * as a free brute-force oracle.
 */
async function checkResetCode(email: string, code: string, context?: ResetContext): Promise<CodeCheck> {
  const normalizedEmail = email.toLowerCase();
  const normalizedCode = normalizeResetCode(code);

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      status: true,
      passwordHash: true,
      resetTokenHash: true,
      resetTokenExpiry: true,
      resetAttempts: true,
    },
  });

  // No user or no outstanding code: stay silent (no audit, no counter) to
  // avoid enumeration via audit logs.
  if (!user?.resetTokenHash || normalizedCode.length === 0) {
    return { ok: false };
  }

  if (user.resetAttempts >= securityConfig.maxTokenAttempts) {
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "max_attempts_exceeded", attempts: user.resetAttempts },
    });
    return { ok: false };
  }

  if (!safeEqual(hashToken(normalizedCode), user.resetTokenHash)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { resetAttempts: { increment: 1 } },
    });
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "invalid_code", attempts: user.resetAttempts + 1 },
    });
    return { ok: false };
  }

  // PENDING with a temp password is a mid-activation invitee - allowed.
  if (user.status === "DISABLED" || (user.status === "PENDING" && !user.passwordHash)) {
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: user.status === "DISABLED" ? "account_disabled" : "registration_incomplete" },
    });
    return { ok: false };
  }

  if (user.resetTokenExpiry && user.resetTokenExpiry < new Date()) {
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "code_expired" },
    });
    return { ok: false };
  }

  return { ok: true, user: { id: user.id, email: user.email, status: user.status } };
}

export async function verifyResetCode(
  email: string,
  code: string,
  context?: ResetContext,
): Promise<{ valid: boolean }> {
  const check = await checkResetCode(email, code, context);
  return { valid: check.ok };
}

export async function resetPassword(
  email: string,
  code: string,
  newPassword: string,
  context?: ResetContext,
): Promise<{ success: true } | { success: false; error: string; details?: string[] }> {
  // Validate password strength
  const passwordValidation = validatePasswordStrength(newPassword);
  if (!passwordValidation.valid) {
    return { success: false, error: "Password does not meet requirements", details: passwordValidation.errors };
  }

  const check = await checkResetCode(email, code, context);
  if (!check.ok) {
    return { success: false, error: "Invalid or expired code" };
  }

  const passwordHash = await hashPassword(newPassword);
  const activatingInvite = check.user.status === "PENDING";

  const sessionsRevoked = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: check.user.id },
      data: {
        passwordHash,
        resetTokenHash: null,
        resetTokenExpiry: null,
        resetAttempts: 0,
        mustChangePassword: false,
        // A code from the account's mailbox proves ownership, so clear any
        // login lockout too (same as an admin unlock).
        failedLoginAttempts: 0,
        lockedUntil: null,
        // A mid-activation invitee choosing their own password completes
        // the invite.
        ...(activatingInvite ? { status: "ACTIVE" as const, inviteTokenExpiry: null } : {}),
      },
    });

    const result = await tx.refreshToken.updateMany({
      where: {
        userId: check.user.id,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return result.count;
  });

  await logEvent({
    action: "PASSWORD_RESET_COMPLETED",
    userId: check.user.id,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: { sessionsRevoked },
  });

  if (activatingInvite) {
    await logEvent({
      action: "INVITE_COMPLETED",
      userId: check.user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { via: "password_reset" },
    });
  }

  return { success: true };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  context?: ResetContext,
): Promise<{ success: true } | { success: false; error: string; details?: string[] }> {
  // Validate password strength
  const passwordValidation = validatePasswordStrength(newPassword);
  if (!passwordValidation.valid) {
    return { success: false, error: "Password does not meet requirements", details: passwordValidation.errors };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      passwordHash: true,
      status: true,
    },
  });

  if (!user) {
    return { success: false, error: "User not found" };
  }

  // PENDING invitees change their temp password here - only DISABLED is out.
  if (user.status === "DISABLED") {
    return { success: false, error: "Account is not active" };
  }

  if (!user.passwordHash) {
    return { success: false, error: "No password set for this account" };
  }

  const isValid = await comparePassword(currentPassword, user.passwordHash);
  if (!isValid) {
    await logEvent({
      action: "PASSWORD_CHANGED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { success: false, reason: "incorrect_current_password" },
    });
    return { success: false, error: "Current password is incorrect" };
  }

  const passwordHash = await hashPassword(newPassword);
  const activatingInvite = user.status === "PENDING";

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      mustChangePassword: false,
      // An invitee replacing their temp password completes the invite
      ...(activatingInvite ? { status: "ACTIVE" as const, inviteTokenExpiry: null } : {}),
    },
  });

  await logEvent({
    action: "PASSWORD_CHANGED",
    userId: user.id,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: { success: true, activatedInvite: activatingInvite },
  });

  if (activatingInvite) {
    await logEvent({
      action: "INVITE_COMPLETED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { via: "password_change" },
    });
  }

  return { success: true };
}

// ============================================================================
// Admin password reset
// ============================================================================

const PASSWORD_UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const PASSWORD_LOWER = "abcdefghjkmnpqrstuvwxyz";
const PASSWORD_DIGITS = "23456789";
const PASSWORD_SPECIAL = "!@#$%^&*";
const PASSWORD_ALL = PASSWORD_UPPER + PASSWORD_LOWER + PASSWORD_DIGITS + PASSWORD_SPECIAL;
const GENERATED_PASSWORD_LENGTH = 16;

/** Random password guaranteed to satisfy validatePasswordStrength. */
export function generateStrongPassword(): string {
  const chars = [
    PASSWORD_UPPER[randomInt(PASSWORD_UPPER.length)],
    PASSWORD_LOWER[randomInt(PASSWORD_LOWER.length)],
    PASSWORD_DIGITS[randomInt(PASSWORD_DIGITS.length)],
    PASSWORD_SPECIAL[randomInt(PASSWORD_SPECIAL.length)],
  ];
  while (chars.length < GENERATED_PASSWORD_LENGTH) {
    chars.push(PASSWORD_ALL[randomInt(PASSWORD_ALL.length)]);
  }
  // Fisher-Yates shuffle so the guaranteed characters aren't always first
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export interface AdminSetPasswordInput {
  targetUserId: string;
  actorId: string;
  workspaceId: string;
  password?: string;
  mode: "temporary" | "permanent";
}

export type AdminSetPasswordError =
  | "USER_NOT_FOUND"
  | "SELF_RESET"
  | "SYSTEM_USER"
  | "OWNER_PERMISSION_REQUIRED"
  | "WEAK_PASSWORD"
  | "PERMANENT_REQUIRES_PASSWORD";

export interface AdminSetPasswordResult {
  mustChangePassword: boolean;
  /** Present only when the server generated the password. Shown once. */
  temporaryPassword?: string;
}

export async function adminSetPassword(
  input: AdminSetPasswordInput,
  context?: ResetContext,
): Promise<
  { success: true; data: AdminSetPasswordResult } | { success: false; error: AdminSetPasswordError; details?: string[] }
> {
  if (input.targetUserId === input.actorId) {
    return { success: false, error: "SELF_RESET" };
  }

  const target = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { id: true, status: true, systemRole: true },
  });

  if (!target) {
    return { success: false, error: "USER_NOT_FOUND" };
  }

  if (target.systemRole) {
    return { success: false, error: "SYSTEM_USER" };
  }

  // Resetting an owner's password is a takeover vector, so it needs the
  // owner permission — same rule as changing an owner's role.
  const targetIsOwner = await prisma.workspaceMembership.findFirst({
    where: {
      workspaceId: input.workspaceId,
      userId: input.targetUserId,
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

  if (targetIsOwner) {
    const actorIsOwner = await hasPermission(input.actorId, OWNER_PERMISSION, {
      workspaceId: input.workspaceId,
    });
    if (!actorIsOwner) {
      return { success: false, error: "OWNER_PERMISSION_REQUIRED" };
    }
  }

  if (input.mode === "permanent" && !input.password) {
    // An admin should never know a user's permanent password
    return { success: false, error: "PERMANENT_REQUIRES_PASSWORD" };
  }

  let password = input.password;
  if (password) {
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return { success: false, error: "WEAK_PASSWORD", details: passwordValidation.errors };
    }
  } else {
    password = generateStrongPassword();
  }

  const mustChangePassword = input.mode === "temporary";
  const passwordHash = await hashPassword(password);

  const sessionsRevoked = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: {
        passwordHash,
        mustChangePassword,
        resetTokenHash: null,
        resetTokenExpiry: null,
        resetAttempts: 0,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    const result = await tx.refreshToken.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return result.count;
  });

  await logEvent({
    action: "PASSWORD_ADMIN_RESET",
    userId: target.id,
    actorId: input.actorId,
    workspaceId: input.workspaceId,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: { mode: input.mode, generated: !input.password, sessionsRevoked },
  });

  return {
    success: true,
    data: {
      mustChangePassword,
      ...(input.password ? {} : { temporaryPassword: password }),
    },
  };
}
