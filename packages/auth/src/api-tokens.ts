import defaultPrisma, { type PrismaClient } from "@rw/db";
import { generateSecret, hashToken } from "./secrets.js";

// Opaque customer/app API tokens ("rw_app_<64 hex chars>"). Same at-rest model
// as gateway and refresh tokens: high-entropy secret, SHA-256 hash stored,
// plaintext returned exactly once at creation (see ./secrets.ts for why plain
// SHA-256 — not bcrypt — is correct here; a deterministic hash is also what
// makes the O(1) unique lookup possible).
//
// Every function takes an optional Prisma client so services with their own
// pool (livestore) don't have to import the shared singleton.

export const API_TOKEN_PREFIX = "rw_app_";

// v1: tokens are read-only. The scopes column exists for forward-compat, but
// creation always writes exactly this set.
export const API_TOKEN_SCOPES = ["graph:read"] as const;

const PREFIX_DISPLAY_CHARS = 8;
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export interface CreateApiTokenInput {
  name: string;
  workspaceId: string;
  siteId: string;
  createdById?: string;
  expiresAt?: Date;
}

export interface CreatedApiToken {
  id: string;
  name: string;
  /** Plaintext token — only returned here, never retrievable again. */
  token: string;
  tokenPrefix: string;
  siteId: string;
  workspaceId: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface ValidatedApiToken {
  id: string;
  name: string;
  workspaceId: string;
  siteId: string;
  scopes: string[];
}

export async function createApiToken(
  input: CreateApiTokenInput,
  db: PrismaClient = defaultPrisma,
): Promise<CreatedApiToken | { error: "SITE_NOT_IN_WORKSPACE" }> {
  const site = await db.site.findFirst({
    where: { id: input.siteId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!site) return { error: "SITE_NOT_IN_WORKSPACE" };

  const secret = generateSecret();
  const token = `${API_TOKEN_PREFIX}${secret}`;
  const tokenPrefix = `${API_TOKEN_PREFIX}${secret.slice(0, PREFIX_DISPLAY_CHARS)}`;

  const record = await db.apiToken.create({
    data: {
      name: input.name,
      tokenHash: hashToken(token),
      tokenPrefix,
      scopes: [...API_TOKEN_SCOPES],
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      createdById: input.createdById ?? null,
      expiresAt: input.expiresAt ?? null,
    },
  });

  return {
    id: record.id,
    name: record.name,
    token,
    tokenPrefix: record.tokenPrefix,
    siteId: record.siteId,
    workspaceId: record.workspaceId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

// Returns the token's identity/scoping, or null for anything not presentable:
// wrong prefix, unknown, revoked, or expired. Callers must not distinguish
// these cases in responses (no existence oracle).
export async function validateApiToken(
  token: string,
  db: PrismaClient = defaultPrisma,
): Promise<ValidatedApiToken | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;

  const record = await db.apiToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt && record.expiresAt < new Date()) return null;

  return {
    id: record.id,
    name: record.name,
    workspaceId: record.workspaceId,
    siteId: record.siteId,
    scopes: record.scopes,
  };
}

// Throttled lastUsed stamp: a single conditional update (no read-then-write
// race), writing at most once per throttle window. Intended to be called
// fire-and-forget — validation must never block on it.
export async function touchApiToken(id: string, db: PrismaClient = defaultPrisma): Promise<void> {
  const cutoff = new Date(Date.now() - LAST_USED_THROTTLE_MS);
  await db.apiToken.updateMany({
    where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] },
    data: { lastUsedAt: new Date() },
  });
}

export async function listApiTokens(workspaceId: string, db: PrismaClient = defaultPrisma) {
  return db.apiToken.findMany({
    where: { workspaceId },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      scopes: true,
      siteId: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function countActiveApiTokens(workspaceId: string, db: PrismaClient = defaultPrisma): Promise<number> {
  return db.apiToken.count({
    where: {
      workspaceId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
}

// Idempotent: revoking an already-revoked token reports the original time.
export async function revokeApiToken(
  id: string,
  workspaceId: string,
  db: PrismaClient = defaultPrisma,
): Promise<{ revokedAt: Date; alreadyRevoked: boolean } | null> {
  const record = await db.apiToken.findFirst({ where: { id, workspaceId } });
  if (!record) return null;
  if (record.revokedAt) return { revokedAt: record.revokedAt, alreadyRevoked: true };

  const updated = await db.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
  return { revokedAt: updated.revokedAt as Date, alreadyRevoked: false };
}
