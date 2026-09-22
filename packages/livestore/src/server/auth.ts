import type { PrismaClient } from "@rw/db";
// @rw/auth/verify is deliberately prisma-free: importing it (and its ./env.js)
// runs the fail-fast JWT_SECRET validation at boot without opening a second DB
// pool next to livestore's own client.
import { isExpiredTokenError, verifyAccessToken } from "@rw/auth/verify";
import { API_TOKEN_PREFIX, touchApiToken, validateApiToken } from "@rw/auth/api-tokens";
import { hashToken } from "@rw/auth/secrets";
import type { IAMContext } from "@rw/auth/context";
import { publishedReadScope, type PublishedReadScope } from "../graph/read-scope.js";

import type { LivestoreLogger } from "../types/index.js";

export type LivestorePrincipal =
  | { kind: "user"; userId: string; workspaceId: string; siteId: string; expMs: number; readScope: PublishedReadScope }
  | { kind: "display"; displayId: string; workspaceId: string; siteId: string; expMs: number }
  | { kind: "app"; apiTokenId: string; workspaceId: string; siteId: string; expMs: null };

interface CacheEntry {
  principal: LivestorePrincipal | null;
  expiresAtMs: number;
}

// Opaque-token validation cache. Positive TTL bounds revocation latency;
// negative TTL blunts DB hammering with garbage tokens. Keyed by token hash so
// no plaintext lives in the map.
const POSITIVE_TTL_MS = 30_000;
const NEGATIVE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 1_000;

export class LivestoreAuthenticator {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: LivestoreLogger,
  ) {}

  // Bearer value → principal, or null for anything not presentable. Callers
  // must respond with a single generic 401/4401 — only logs distinguish
  // expired/malformed/revoked.
  async authenticate(bearer: string): Promise<LivestorePrincipal | null> {
    if (bearer.startsWith(API_TOKEN_PREFIX)) {
      return this.authenticateApiToken(bearer);
    }
    return this.authenticateJwt(bearer);
  }

  private async authenticateJwt(token: string): Promise<LivestorePrincipal | null> {
    let decoded: ReturnType<typeof verifyAccessToken>;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      if (isExpiredTokenError(err)) {
        this.logger.info({}, "livestore auth: access token expired");
      } else {
        this.logger.warn({}, "livestore auth: rejected invalid access token");
      }
      return null;
    }

    const expMs = decoded.exp * 1000;

    if (decoded.principal === "DISPLAY") {
      return {
        kind: "display",
        displayId: decoded.displayId,
        workspaceId: decoded.workspaceId,
        siteId: decoded.siteId,
        expMs,
      };
    }

    if (!decoded.workspaceId || !decoded.siteId) {
      this.logger.info({}, "livestore auth: user token without workspace/site context");
      return null;
    }

    const key = hashToken(token);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs > Date.now()) return cached.principal;
    const principal = await this.resolveUser(decoded.id, decoded.workspaceId, decoded.siteId, expMs);
    this.remember(key, principal);
    return principal;
  }

  private async resolveUser(
    userId: string,
    workspaceId: string,
    siteId: string,
    expMs: number,
  ): Promise<LivestorePrincipal | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, lockedUntil: true, mustChangePassword: true, systemRole: true },
    });
    if (
      !user ||
      user.status !== "ACTIVE" ||
      user.mustChangePassword ||
      (user.lockedUntil && user.lockedUntil > new Date())
    )
      return null;
    const site = await this.prisma.site.findFirst({ where: { id: siteId, workspaceId }, select: { id: true } });
    if (!site) return null;
    const iam: IAMContext = { principal: "USER", validToken: true, id: userId, workspaceId, siteId };
    if (user.systemRole) {
      iam.permissionSnapshot = { systemRole: user.systemRole, assignments: [] };
    } else {
      const membership = await this.prisma.workspaceMembership.findUnique({
        where: { userId_workspaceId: { userId, workspaceId } },
        select: { id: true },
      });
      if (!membership) return null;
      const [assignments, grants] = await Promise.all([
        this.prisma.roleAssignment.findMany({
          where: { membership: { userId, workspaceId } },
          select: { siteId: true, workcenterId: true, role: { select: { permissions: true } } },
        }),
        this.prisma.workcenterGrant.findMany({
          where: { membership: { userId, workspaceId } },
          select: { workcenterId: true, access: true, workcenter: { select: { siteId: true } } },
        }),
      ]);
      iam.permissionSnapshot = {
        systemRole: null,
        assignments: assignments.map((a) => ({
          siteId: a.siteId,
          workcenterId: a.workcenterId,
          permissions: a.role.permissions,
        })),
        workcenterGrants: grants.map((g) => ({
          workcenterId: g.workcenterId,
          siteId: g.workcenter.siteId,
          access: g.access,
        })),
      };
    }
    const readScope = await publishedReadScope(iam, siteId);
    if (!readScope) return null;
    return {
      kind: "user",
      userId,
      workspaceId,
      siteId,
      readScope,
      expMs,
    };
  }

  private remember(key: string, principal: LivestorePrincipal | null) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { principal, expiresAtMs: Date.now() + (principal ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  }

  private async authenticateApiToken(token: string): Promise<LivestorePrincipal | null> {
    const key = hashToken(token);
    const now = Date.now();

    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs > now) {
      return cached.principal;
    }

    const validated = await validateApiToken(token, this.prisma);
    const principal: LivestorePrincipal | null = validated?.scopes.includes("graph:read")
      ? {
          kind: "app",
          apiTokenId: validated.id,
          workspaceId: validated.workspaceId,
          siteId: validated.siteId,
          expMs: null,
        }
      : null;

    if (!validated) {
      this.logger.warn({}, "livestore auth: rejected invalid api token");
    } else {
      void touchApiToken(validated.id, this.prisma).catch(() => {});
    }

    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Simple insertion-order eviction; entries are short-lived anyway.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, {
      principal,
      expiresAtMs: now + (principal ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });

    return principal;
  }

  // Re-check an app principal against the cache/DB (used by the WS periodic
  // revalidation). Returns false when the token no longer validates.
  async revalidateApiToken(token: string): Promise<boolean> {
    return (await this.authenticateApiToken(token)) !== null;
  }
}

export function bearerFromAuthorizationHeader(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}
