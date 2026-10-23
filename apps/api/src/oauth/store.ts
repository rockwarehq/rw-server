import { createHash } from "node:crypto";
import prisma from "@rw/db";
import { REFRESH_REUSE_GRACE_MS } from "@rw/auth/tokens";
import { generateSecret, hashToken, safeEqual } from "@rw/auth/secrets";

// OAuth 2.1 for agents over MCP: clients, grants, codes and tokens. A grant
// is one person letting one client act at one site, up to some scopes. Every
// code and token hangs off a grant, so revoking it ends the connection.
//
// Tokens are opaque and hashed at rest (like ApiToken). Access tokens carry
// their own prefix so the general auth path can refuse them: they are only
// accepted on /mcp.

export const OAUTH_ACCESS_PREFIX = "rw_mcp_";
export const OAUTH_REFRESH_PREFIX = "rw_mcr_";

export const OAUTH_SCOPES = ["read", "setup:propose"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export function isOAuthScope(value: string): value is OAuthScope {
  return (OAUTH_SCOPES as readonly string[]).includes(value);
}

/** "setup:propose" implies "read"; unknown scopes are dropped. */
export function normalizeScopes(scopes: readonly string[]): OAuthScope[] {
  const known = new Set(scopes.filter(isOAuthScope));
  if (known.has("setup:propose")) known.add("read");
  return OAUTH_SCOPES.filter((scope) => known.has(scope));
}

// RFC 8252: native apps redirect to the loopback interface on any port.
// Everything else must be https.
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

// A registered redirect URI matches exactly, except that a loopback URI may
// come back on another port (the agent picks a free one per login).
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let url: URL;
  try {
    url = new URL(presented);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return registered.some((candidate) => {
    try {
      const reg = new URL(candidate);
      return (
        reg.protocol === "http:" &&
        reg.hostname === url.hostname &&
        reg.pathname === url.pathname &&
        reg.search === url.search
      );
    } catch {
      return false;
    }
  });
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function registerClient(input: { name: string; redirectUris: string[] }) {
  return prisma.oAuthClient.create({ data: { name: input.name, redirectUris: input.redirectUris } });
}

export async function findClient(clientId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return null;
  return prisma.oAuthClient.findUnique({ where: { id: clientId } });
}

/** Approve: create the grant and a single-use code for it. */
export async function createGrantWithCode(input: {
  userId: string;
  workspaceId: string;
  siteId: string;
  clientId: string;
  scopes: OAuthScope[];
  codeChallenge: string;
  redirectUri: string;
}): Promise<{ grantId: string; code: string }> {
  const code = generateSecret();
  const grant = await prisma.oAuthGrant.create({
    data: {
      userId: input.userId,
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      clientId: input.clientId,
      scopes: input.scopes,
      codes: {
        create: {
          codeHash: hashToken(code),
          codeChallenge: input.codeChallenge,
          redirectUri: input.redirectUri,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      },
    },
  });
  return { grantId: grant.id, code };
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
}

async function issueTokens(grantId: string, scopes: string[]): Promise<IssuedTokens> {
  const accessToken = `${OAUTH_ACCESS_PREFIX}${generateSecret()}`;
  const refreshToken = `${OAUTH_REFRESH_PREFIX}${generateSecret()}`;
  const now = Date.now();
  await prisma.oAuthToken.createMany({
    data: [
      { kind: "ACCESS", tokenHash: hashToken(accessToken), grantId, expiresAt: new Date(now + ACCESS_TTL_MS) },
      { kind: "REFRESH", tokenHash: hashToken(refreshToken), grantId, expiresAt: new Date(now + REFRESH_TTL_MS) },
    ],
  });
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), scopes };
}

export type TokenError = { error: "invalid_grant" | "invalid_client"; description: string };

/** authorization_code grant: single use, PKCE-bound, same client + redirect. */
export async function exchangeCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<IssuedTokens | TokenError> {
  const record = await prisma.oAuthCode.findUnique({
    where: { codeHash: hashToken(input.code) },
    include: { grant: true },
  });
  if (!record) return { error: "invalid_grant", description: "Unknown authorization code" };

  // Claim it first, atomically: a second exchange of the same code finds
  // usedAt set. A replayed code is a stolen code, so the grant goes too.
  const claimed = await prisma.oAuthCode.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    await revokeGrant(record.grantId);
    return { error: "invalid_grant", description: "Authorization code was already used" };
  }

  if (record.expiresAt < new Date()) return { error: "invalid_grant", description: "Authorization code expired" };
  if (record.grant.clientId !== input.clientId) {
    return { error: "invalid_grant", description: "Code was issued to another client" };
  }
  if (record.redirectUri !== input.redirectUri) {
    return { error: "invalid_grant", description: "redirect_uri does not match the authorization request" };
  }
  if (!input.codeVerifier || !safeEqual(pkceChallenge(input.codeVerifier), record.codeChallenge)) {
    return { error: "invalid_grant", description: "PKCE verification failed" };
  }
  if (record.grant.revokedAt) return { error: "invalid_grant", description: "Grant was revoked" };

  return issueTokens(record.grantId, record.grant.scopes);
}

/**
 * refresh_token grant with rotation. A rotated token presented again inside
 * the reuse grace window (parallel tool calls racing a refresh, a lost
 * response) refreshes normally; after it, reuse means theft and the whole
 * grant is revoked.
 */
export async function refreshTokens(input: {
  refreshToken: string;
  clientId: string;
}): Promise<IssuedTokens | TokenError> {
  const record = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashToken(input.refreshToken) },
    include: { grant: true },
  });
  if (!record || record.kind !== "REFRESH") return { error: "invalid_grant", description: "Unknown refresh token" };
  if (record.grant.clientId !== input.clientId) {
    return { error: "invalid_grant", description: "Token was issued to another client" };
  }
  if (record.grant.revokedAt) return { error: "invalid_grant", description: "Grant was revoked" };

  if (record.revokedAt) {
    const withinGrace = record.rotatedAt !== null && Date.now() - record.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
    if (!withinGrace) {
      await revokeGrant(record.grantId);
      return { error: "invalid_grant", description: "Refresh token reuse detected; the connection was revoked" };
    }
    return issueTokens(record.grantId, record.grant.scopes);
  }
  if (record.expiresAt < new Date()) return { error: "invalid_grant", description: "Refresh token expired" };

  const now = new Date();
  // Conditional, so a parallel refresh of the same token that loses the race
  // just finds it rotated a moment ago: the benign case the grace covers.
  await prisma.oAuthToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: now, rotatedAt: now },
  });
  return issueTokens(record.grantId, record.grant.scopes);
}

export interface ResolvedAccessToken {
  grantId: string;
  userId: string;
  workspaceId: string;
  siteId: string;
  scopes: OAuthScope[];
  clientId: string;
  clientName: string;
}

/** A live access token on a live grant, or null. Never says which check failed. */
export async function resolveAccessToken(token: string): Promise<ResolvedAccessToken | null> {
  if (!token.startsWith(OAUTH_ACCESS_PREFIX)) return null;
  const record = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { grant: { include: { client: { select: { id: true, name: true } } } } },
  });
  if (!record || record.kind !== "ACCESS") return null;
  if (record.revokedAt || record.expiresAt < new Date()) return null;
  const grant = record.grant;
  if (grant.revokedAt) return null;

  void touchGrant(grant.id).catch(() => {});
  return {
    grantId: grant.id,
    userId: grant.userId,
    workspaceId: grant.workspaceId,
    siteId: grant.siteId,
    scopes: normalizeScopes(grant.scopes),
    clientId: grant.client.id,
    clientName: grant.client.name,
  };
}

async function touchGrant(id: string) {
  const cutoff = new Date(Date.now() - LAST_USED_THROTTLE_MS);
  await prisma.oAuthGrant.updateMany({
    where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] },
    data: { lastUsedAt: new Date() },
  });
}

/** End a connection: the grant and every token on it. */
export async function revokeGrant(grantId: string): Promise<boolean> {
  const now = new Date();
  const [grant] = await prisma.$transaction([
    prisma.oAuthGrant.updateMany({ where: { id: grantId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.oAuthToken.updateMany({ where: { grantId, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  return grant.count > 0;
}
