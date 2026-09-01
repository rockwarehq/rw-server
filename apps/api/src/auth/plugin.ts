import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import createError from "http-errors";
import { verifyAccessToken, isExpiredTokenError, type DecodedAccessToken } from "@rw/auth/tokens";
import { API_TOKEN_PREFIX, touchApiToken, validateApiToken } from "@rw/auth/api-tokens";
import { type PermissionSnapshot, snapshotAccessibleSites } from "@rw/auth/iam/index";
import { Principal, type AppIAMContext, type IAMContext, type UnknownIAMContext } from "@rw/auth/context";
import prisma from "@rw/db";

const AUTH_HEADER_PREFIX = "Bearer ";

interface LegacyDecodedUserAccessToken {
  id: string;
  email: string;
  workspaceId?: string;
  siteId?: string;
  iat: number;
  exp: number;
}

function isDisplayAccessToken(
  decodedToken: DecodedAccessToken,
): decodedToken is DecodedAccessToken & { principal: "DISPLAY" } {
  return decodedToken.principal === Principal.DISPLAY;
}

async function resolveDisplayIAM(displayId: string): Promise<IAMContext> {
  const iam: UnknownIAMContext = {
    principal: Principal.UNKNOWN,
    validToken: false,
  };

  const display = await prisma.display.findUnique({
    where: { id: displayId },
    select: {
      id: true,
      name: true,
      status: true,
      siteId: true,
      dashboardId: true,
      workcenterId: true,
      stationId: true,
      site: {
        select: {
          id: true,
          workspaceId: true,
          workspace: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      },
    },
  });

  if (!display || display.status !== "CLAIMED" || !display.siteId || !display.site) {
    return iam;
  }

  return {
    principal: Principal.DISPLAY,
    validToken: true,
    displayId: display.id,
    siteId: display.siteId,
    workspaceId: display.site.workspaceId,
    display: {
      id: display.id,
      name: display.name,
      status: display.status,
      siteId: display.siteId,
      dashboardId: display.dashboardId,
      workcenterId: display.workcenterId,
      stationId: display.stationId,
    },
    workspace: {
      id: display.site.workspace.id,
      name: display.site.workspace.name,
      slug: display.site.workspace.slug,
    },
  };
}

declare module "fastify" {
  interface FastifyRequest {
    iam?: IAMContext;
  }
  interface FastifyInstance {
    verifyAccessToken: (
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply,
    ) => Promise<void>;
  }
}

interface RequestLogger {
  debug: (msg: string) => void;
  warn: (objOrMsg: object | string, msg?: string) => void;
}

async function resolveIAM(authHeader: string, log?: RequestLogger): Promise<IAMContext> {
  const iam: IAMContext = {
    principal: Principal.UNKNOWN,
    validToken: false,
  };

  if (!authHeader.startsWith(AUTH_HEADER_PREFIX)) {
    return iam;
  }

  const token = authHeader.substring(AUTH_HEADER_PREFIX.length);

  // Opaque customer/app API tokens are routed by prefix before JWT decoding.
  // The prefix carries no authority — a forged one just fails the hash lookup.
  if (token.startsWith(API_TOKEN_PREFIX)) {
    return resolveAppIAM(token, log);
  }

  let decodedToken: DecodedAccessToken;
  try {
    decodedToken = verifyAccessToken(token);
  } catch (err) {
    // Distinguish an expired token (routine — client should refresh) from a
    // malformed/wrongly-signed one (potential attack). Never log the token.
    if (isExpiredTokenError(err)) {
      log?.debug("auth: access token expired");
    } else {
      log?.warn("auth: rejected invalid access token");
    }
    return iam;
  }

  if (isDisplayAccessToken(decodedToken)) {
    return resolveDisplayIAM(decodedToken.displayId);
  }

  return resolveUserIAM(decodedToken);
}

async function resolveAppIAM(token: string, log?: RequestLogger): Promise<IAMContext> {
  const validated = await validateApiToken(token);
  if (!validated) {
    // Unknown, revoked, and expired all look identical to the caller.
    log?.warn("auth: rejected invalid api token");
    return { principal: Principal.UNKNOWN, validToken: false };
  }

  // Fire-and-forget by design, but never silently: a failing touch means
  // last-used tracking is broken (or the DB is unhappy) and we want to know.
  void touchApiToken(validated.id).catch((err) => {
    log?.warn({ err }, "auth: failed to touch api token last-used timestamp");
  });

  const iam: AppIAMContext = {
    principal: Principal.APP,
    validToken: true,
    apiTokenId: validated.id,
    workspaceId: validated.workspaceId,
    siteId: validated.siteId,
    scopes: validated.scopes,
  };
  return iam;
}

async function resolveUserIAM(decodedToken: LegacyDecodedUserAccessToken): Promise<IAMContext> {
  const invalidIAM: UnknownIAMContext = {
    principal: Principal.UNKNOWN,
    validToken: false,
  };

  const userResult = await prisma.user.findUnique({
    where: { id: decodedToken.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      lockedUntil: true,
      systemRole: true,
      mustChangePassword: true,
    },
  });

  if (!userResult) {
    return invalidIAM;
  }

  // PENDING invitees (temp password not yet changed) get an IAM context so
  // they can reach the password-change allowlist; any other non-ACTIVE state
  // - including PENDING with the flag somehow cleared - gets nothing.
  const pendingInvitee = userResult.status === "PENDING" && userResult.mustChangePassword;
  if (userResult.status !== "ACTIVE" && !pendingInvitee) {
    return invalidIAM;
  }

  if (userResult.lockedUntil && userResult.lockedUntil > new Date()) {
    return invalidIAM;
  }

  if (!decodedToken.workspaceId) {
    return invalidIAM;
  }

  // System users (SUPPORT/ENGINEER staff) hold no memberships by design —
  // their workspace context is validated directly against the workspace row.
  let workspaceContext: { id: string; name: string; slug: string } | null;
  if (userResult.systemRole) {
    workspaceContext = await prisma.workspace.findUnique({
      where: { id: decodedToken.workspaceId },
      select: { id: true, name: true, slug: true },
    });
  } else {
    const membership = await prisma.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId: decodedToken.id,
          workspaceId: decodedToken.workspaceId,
        },
      },
      select: {
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });
    workspaceContext = membership?.workspace ?? null;
  }

  if (!workspaceContext) {
    return invalidIAM;
  }

  // Resolve the role/permission snapshot once; the site-claim check below
  // and every downstream policy evaluation share it instead of re-querying.
  let permissionSnapshot: PermissionSnapshot;
  if (userResult.systemRole) {
    permissionSnapshot = { systemRole: userResult.systemRole, assignments: [] };
  } else {
    const membershipWhere = { userId: decodedToken.id, workspaceId: decodedToken.workspaceId };
    const [assignments, workcenterGrants] = await Promise.all([
      prisma.roleAssignment.findMany({
        where: { membership: membershipWhere },
        select: { siteId: true, role: { select: { permissions: true } } },
      }),
      prisma.workcenterGrant.findMany({
        where: { membership: membershipWhere },
        select: { workcenterId: true, access: true, workcenter: { select: { siteId: true } } },
      }),
    ]);
    permissionSnapshot = {
      systemRole: null,
      assignments: assignments.map((a) => ({ siteId: a.siteId, permissions: a.role.permissions })),
      workcenterGrants: workcenterGrants.map((g) => ({
        workcenterId: g.workcenterId,
        siteId: g.workcenter.siteId,
        access: g.access,
      })),
    };
  }

  if (decodedToken.siteId) {
    const access = snapshotAccessibleSites(permissionSnapshot, "facility:read");
    if (access.all) {
      // All-sites grants still require the claimed site to exist in the
      // workspace (parity with the listAccessibleSites-based check).
      const site = await prisma.site.findFirst({
        where: { id: decodedToken.siteId, workspaceId: decodedToken.workspaceId },
        select: { id: true },
      });
      if (!site) {
        return invalidIAM;
      }
    } else if (!access.siteIds.includes(decodedToken.siteId)) {
      return invalidIAM;
    }
  }

  return {
    principal: Principal.USER,
    validToken: true,
    id: decodedToken.id,
    email: userResult.email,
    workspaceId: decodedToken.workspaceId,
    siteId: decodedToken.siteId,
    workspace: workspaceContext,
    permissionSnapshot,
    user: {
      id: userResult.id,
      email: userResult.email,
      firstName: userResult.firstName,
      lastName: userResult.lastName,
      status: userResult.status,
      mustChangePassword: userResult.mustChangePassword,
    },
  };
}

async function iamDecorator(request: FastifyRequest) {
  if (request.headers.authorization) {
    try {
      request.iam = await resolveIAM(request.headers.authorization, request.log);
    } catch {
      // Swallow error, IAM will remain undefined/invalid
    }
  }
}

async function verifyAccessTokenDecorator(request: FastifyRequest, _reply: FastifyReply) {
  if (!request.iam?.validToken || request.iam.principal !== Principal.USER) {
    throw createError.Unauthorized();
  }
}

// While a user must change an admin-issued temporary password, they may only
// change it or manage their session. Everything else — including all /rpc/*
// procedures, which route through this plugin's hooks — is rejected.
const PASSWORD_CHANGE_ALLOWED_ROUTES = new Set([
  "PUT /users/me/password", // the change itself
  "GET /users/me", // lets the client re-derive state on load
  "POST /auth/login", // public, but clients may attach a stale bearer
  "POST /auth/logout",
  "POST /auth/refresh", // keeps the change-password screen alive
]);

async function enforcePasswordChange(request: FastifyRequest, reply: FastifyReply) {
  const iam = request.iam;
  if (!iam?.validToken || iam.principal !== Principal.USER || !iam.user?.mustChangePassword) {
    return;
  }
  const route = `${request.method} ${request.routeOptions?.url ?? request.url}`;
  if (PASSWORD_CHANGE_ALLOWED_ROUTES.has(route)) {
    return;
  }
  // Pre-serialized so per-route response schemas can't strip the `code`
  // field clients use to redirect to the change-password screen.
  return reply
    .status(403)
    .header("content-type", "application/json; charset=utf-8")
    .send(JSON.stringify({ error: "Password change required", code: "password_change_required" }));
}

async function authPluginImpl(server: FastifyInstance) {
  // Add IAM resolution to every request
  server.addHook("preHandler", iamDecorator);

  // Hooks run in registration order, so this sees the resolved IAM context
  server.addHook("preHandler", enforcePasswordChange);

  // Decorate with verification function for protected routes
  server.decorate("verifyAccessToken", verifyAccessTokenDecorator);
}

export const authPlugin = fp(authPluginImpl, {
  name: "authPlugin",
});
