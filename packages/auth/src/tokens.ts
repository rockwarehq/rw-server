import prisma from "@rw/db";
import { generateSecret, hashToken } from "./secrets.js";

// Re-exported for compatibility with existing `@rw/auth/tokens` importers;
// the implementations live in ./secrets.ts and ./verify.ts. JWT logic sits in
// ./verify.ts (prisma-free) so services with their own Prisma client can
// verify access tokens without importing the shared singleton below.
export { hashToken };
export {
  createAccessToken,
  verifyAccessToken,
  isExpiredTokenError,
  type AccessTokenPayload,
  type DisplayAccessTokenPayload,
  type AnyAccessTokenPayload,
  type DecodedAccessToken,
} from "./verify.js";

const REFRESH_TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

// Reuse-grace interval: a rotated (revoked) token presented again within this
// window refreshes normally instead of tripping theft detection. Benign
// re-presentations are common — a rotation response lost when the API restarts
// mid-request (deploys run a single machine), or two tabs sharing one token
// refreshing concurrently — and family-wide revocation on those logs every
// session out. Reuse AFTER the window is still treated as theft.
export const REFRESH_REUSE_GRACE_MS = 60 * 1000;

export async function createRefreshToken(
  userId: string,
  metadata?: { userAgent?: string; ipAddress?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSecret();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY);

  await prisma.refreshToken.create({
    data: {
      tokenHash,
      expiresAt,
      userAgent: metadata?.userAgent,
      ipAddress: metadata?.ipAddress,
      userId,
    },
  });

  return { token, expiresAt };
}

export async function createDisplayRefreshToken(
  displayId: string,
  metadata?: { userAgent?: string; ipAddress?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSecret();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY);

  await prisma.displayRefreshToken.create({
    data: {
      tokenHash,
      expiresAt,
      userAgent: metadata?.userAgent,
      ipAddress: metadata?.ipAddress,
      displayId,
    },
  });

  return { token, expiresAt };
}

// Distinguishes a token that was never issued ("unknown") from one that was
// issued but is now "revoked" or "expired". A "revoked" result on presentation
// is the classic refresh-token-reuse signal: the caller should treat it as
// theft and revoke the whole token family.
export type RefreshTokenStatus = "valid" | "revoked" | "expired" | "unknown";

export async function inspectRefreshToken(
  token: string,
): Promise<{ status: RefreshTokenStatus; userId?: string; tokenId?: string; rotatedAt?: Date }> {
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record) return { status: "unknown" };
  if (record.revokedAt)
    return {
      status: "revoked",
      userId: record.userId,
      tokenId: record.id,
      rotatedAt: record.rotatedAt ?? undefined,
    };
  if (record.expiresAt < new Date()) return { status: "expired", userId: record.userId, tokenId: record.id };
  return { status: "valid", userId: record.userId, tokenId: record.id };
}

export async function inspectDisplayRefreshToken(
  token: string,
): Promise<{ status: RefreshTokenStatus; displayId?: string; tokenId?: string; rotatedAt?: Date }> {
  const record = await prisma.displayRefreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record) return { status: "unknown" };
  if (record.revokedAt)
    return {
      status: "revoked",
      displayId: record.displayId,
      tokenId: record.id,
      rotatedAt: record.rotatedAt ?? undefined,
    };
  if (record.expiresAt < new Date()) return { status: "expired", displayId: record.displayId, tokenId: record.id };
  return { status: "valid", displayId: record.displayId, tokenId: record.id };
}

export async function verifyRefreshToken(token: string): Promise<{
  valid: boolean;
  userId?: string;
  tokenId?: string;
}> {
  const tokenHash = hashToken(token);

  const refreshToken = await prisma.refreshToken.findUnique({
    where: { tokenHash },
  });

  if (!refreshToken) {
    return { valid: false };
  }

  if (refreshToken.revokedAt) {
    return { valid: false };
  }

  if (refreshToken.expiresAt < new Date()) {
    return { valid: false };
  }

  return {
    valid: true,
    userId: refreshToken.userId,
    tokenId: refreshToken.id,
  };
}

export async function verifyDisplayRefreshToken(token: string): Promise<{
  valid: boolean;
  displayId?: string;
  tokenId?: string;
}> {
  const tokenHash = hashToken(token);

  const refreshToken = await prisma.displayRefreshToken.findUnique({
    where: { tokenHash },
  });

  if (!refreshToken) {
    return { valid: false };
  }

  if (refreshToken.revokedAt) {
    return { valid: false };
  }

  if (refreshToken.expiresAt < new Date()) {
    return { valid: false };
  }

  return {
    valid: true,
    displayId: refreshToken.displayId,
    tokenId: refreshToken.id,
  };
}

// `rotated: true` marks a rotation revocation (the token was replaced by a
// successor), which the reuse grace window honors. Security revocations
// (logout, logout-all, theft response) leave rotatedAt null and get no grace.
export async function revokeRefreshToken(
  token: string,
  options?: { rotated?: boolean },
): Promise<boolean> {
  const tokenHash = hashToken(token);
  const now = new Date();

  try {
    await prisma.refreshToken.update({
      where: { tokenHash },
      data: { revokedAt: now, ...(options?.rotated ? { rotatedAt: now } : {}) },
    });
    return true;
  } catch {
    return false;
  }
}

export async function revokeDisplayRefreshToken(
  token: string,
  options?: { rotated?: boolean },
): Promise<boolean> {
  const tokenHash = hashToken(token);
  const now = new Date();

  try {
    await prisma.displayRefreshToken.update({
      where: { tokenHash },
      data: { revokedAt: now, ...(options?.rotated ? { rotatedAt: now } : {}) },
    });
    return true;
  } catch {
    return false;
  }
}

export async function revokeAllUserRefreshTokens(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function revokeAllDisplayRefreshTokens(displayId: string): Promise<number> {
  const result = await prisma.displayRefreshToken.updateMany({
    where: {
      displayId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function cleanupExpiredTokens(): Promise<number> {
  const result = await prisma.refreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
    },
  });
  return result.count;
}

export async function cleanupExpiredDisplayTokens(): Promise<number> {
  const result = await prisma.displayRefreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
    },
  });
  return result.count;
}
