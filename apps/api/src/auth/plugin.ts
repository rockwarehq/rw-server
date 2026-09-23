import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import createError from "http-errors";
import { verifyAccessToken, isExpiredTokenError, type DecodedAccessToken } from "@rw/auth/tokens";
import { API_TOKEN_PREFIX, touchApiToken, validateApiToken } from "@rw/auth/api-tokens";
import {
  type Access,
  AccessDenied,
  DeviceAccess,
  noAccess,
  personSelect,
  toPerson,
  UserAccess,
} from "@rw/auth/iam/access";
import { replyAccessDenied } from "../api/authz.js";
import type { AccessTokenPayload } from "@rw/auth/verify";
import type { Current } from "@rw/auth/context";
import prisma from "@rw/db";

// Who is calling, worked out once per request (like Basecamp's `Current`):
// request.current is the caller (null when anonymous or invalid), and
// request.access answers "may they do this?" for handlers.

const AUTH_HEADER_PREFIX = "Bearer ";

declare module "fastify" {
  interface FastifyRequest {
    current: Current | null;
    access: Access;
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

export async function authenticate(authHeader: string, log?: RequestLogger): Promise<Current | null> {
  if (!authHeader.startsWith(AUTH_HEADER_PREFIX)) return null;
  const token = authHeader.substring(AUTH_HEADER_PREFIX.length);

  // Opaque customer/app API tokens are routed by prefix before JWT decoding.
  // The prefix carries no authority — a forged one just fails the hash lookup.
  if (token.startsWith(API_TOKEN_PREFIX)) return authenticateApp(token, log);

  let decoded: DecodedAccessToken;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    // Distinguish an expired token (routine — client should refresh) from a
    // malformed/wrongly-signed one (potential attack). Never log the token.
    if (isExpiredTokenError(err)) {
      log?.debug("auth: access token expired");
    } else {
      log?.warn("auth: rejected invalid access token");
    }
    return null;
  }

  if (decoded.principal === "DISPLAY") return authenticateDisplay(decoded.displayId);
  return authenticateUser(decoded);
}

async function authenticateDisplay(displayId: string): Promise<Current | null> {
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
      site: { select: { workspaceId: true } },
    },
  });
  if (!display || display.status !== "CLAIMED" || !display.siteId || !display.site) return null;

  return {
    kind: "display",
    display: { ...display, siteId: display.siteId },
    workspaceId: display.site.workspaceId,
    siteId: display.siteId,
    access: new DeviceAccess("display", display.siteId),
  };
}

async function authenticateApp(token: string, log?: RequestLogger): Promise<Current | null> {
  const validated = await validateApiToken(token);
  if (!validated) {
    // Unknown, revoked, and expired all look identical to the caller.
    log?.warn("auth: rejected invalid api token");
    return null;
  }

  // Fire-and-forget by design, but never silently: a failing touch means
  // last-used tracking is broken (or the DB is unhappy) and we want to know.
  void touchApiToken(validated.id).catch((err) => {
    log?.warn({ err }, "auth: failed to touch api token last-used timestamp");
  });

  return {
    kind: "app",
    tokenId: validated.id,
    scopes: validated.scopes,
    workspaceId: validated.workspaceId,
    siteId: validated.siteId,
    access: new DeviceAccess("app", validated.siteId),
  };
}

/** The account's workspace id. It never changes in a deployment, so it is read once. */
let accountWorkspaceId: string | null = null;
async function isAccountWorkspace(workspaceId: string): Promise<boolean> {
  if (!accountWorkspaceId) {
    const workspace = await prisma.workspace.findFirst({ select: { id: true } });
    accountWorkspaceId = workspace?.id ?? null;
  }
  return workspaceId === accountWorkspaceId;
}

async function authenticateUser(token: AccessTokenPayload): Promise<Current | null> {
  const workspaceId = token.workspaceId;
  if (!workspaceId || !(await isAccountWorkspace(workspaceId))) return null;

  // One query: the user and their bucket rows.
  const user = await prisma.user.findUnique({
    where: { id: token.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      lockedUntil: true,
      mustChangePassword: true,
      ...personSelect,
    },
  });
  if (!user) return null;

  // PENDING invitees (temp password not yet changed) get a context so they
  // can reach the password-change allowlist; any other non-ACTIVE state -
  // including PENDING with the flag somehow cleared - gets nothing.
  const pendingInvitee = user.status === "PENDING" && user.mustChangePassword;
  if (user.status !== "ACTIVE" && !pendingInvitee) return null;
  if (user.lockedUntil && user.lockedUntil > new Date()) return null;

  const person = toPerson(user);

  const siteId = token.siteId ?? null;
  if (siteId) {
    // The token's site must still be one the user can see.
    const access = new UserAccess(person, siteId);
    const sites = access.sites();
    if (sites === "all") {
      const site = await prisma.site.findFirst({ where: { id: siteId, workspaceId }, select: { id: true } });
      if (!site) return null;
    } else if (!sites.includes(siteId)) {
      return null;
    }
  }

  return {
    kind: "user",
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
    },
    workspaceId,
    siteId,
    access: new UserAccess(person, siteId),
  };
}

async function currentDecorator(request: FastifyRequest) {
  request.current = null;
  request.access = noAccess;
  if (!request.headers.authorization) return;
  try {
    request.current = await authenticate(request.headers.authorization, request.log);
  } catch (err) {
    // Treat as anonymous, but say why.
    request.log.warn({ err }, "auth: failed to resolve caller");
  }
  request.access = request.current?.access ?? noAccess;
}

async function verifyAccessTokenDecorator(request: FastifyRequest, _reply: FastifyReply) {
  if (request.current?.kind !== "user") {
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
  const current = request.current;
  if (current?.kind !== "user" || !current.user.mustChangePassword) {
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
  server.decorateRequest("current", null);
  server.decorateRequest("access", null as unknown as Access);

  // Work out the caller on every request
  server.addHook("preHandler", currentDecorator);

  // Hooks run in registration order, so this sees the resolved caller
  server.addHook("preHandler", enforcePasswordChange);

  // Access checks throw AccessDenied; answer them here once. Everything
  // else goes to the handler that was in place before (Fastify's default),
  // unchanged.
  const fallbackErrorHandler = server.errorHandler;
  server.setErrorHandler(function (error, request, reply) {
    if (error instanceof AccessDenied) return replyAccessDenied(reply, error);
    return fallbackErrorHandler.call(this, error, request, reply);
  });

  // Decorate with verification function for protected routes
  server.decorate("verifyAccessToken", verifyAccessTokenDecorator);
}

export const authPlugin = fp(authPluginImpl, {
  name: "authPlugin",
});
