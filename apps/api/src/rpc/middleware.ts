import { os, ORPCError } from "@orpc/server";
import { timingSafeEqual } from "node:crypto";
import { processorConfig } from "../config.js";
import { Principal } from "../auth/index.js";
import type {
  DisplayAuthenticatedRPCContext,
  GraphReadRPCContext,
  PrincipalAuthenticatedRPCContext,
  RPCContext,
  UserAuthenticatedRPCContext,
} from "./context.js";

// Base procedure builder with context type
export const publicProcedure = os.$context<RPCContext>();

// User auth middleware - requires valid user authentication
const userMiddleware = os.$context<RPCContext>().middleware(async ({ context, next }) => {
  if (!context.iam?.validToken || context.iam.principal !== Principal.USER) {
    throw new ORPCError("UNAUTHORIZED", { message: "Authentication required" });
  }

  return next({
    context: {
      iam: context.iam as UserAuthenticatedRPCContext["iam"],
    },
  });
});

// User or display principal. Explicit allowlist — APP (customer API token)
// principals must NOT pass here; they are only admitted by the graph-read
// middleware below.
const principalMiddleware = os.$context<RPCContext>().middleware(async ({ context, next }) => {
  if (
    !context.iam?.validToken ||
    (context.iam.principal !== Principal.USER && context.iam.principal !== Principal.DISPLAY)
  ) {
    throw new ORPCError("UNAUTHORIZED", { message: "Authentication required" });
  }

  return next({
    context: {
      iam: context.iam as PrincipalAuthenticatedRPCContext["iam"],
    },
  });
});

// Graph read access: the only middleware that also admits APP principals
// (site-scoped, read-only customer API tokens). Use exclusively on graph.*
// read procedures.
const graphReadPrincipalMiddleware = os.$context<RPCContext>().middleware(async ({ context, next }) => {
  if (
    !context.iam?.validToken ||
    (context.iam.principal !== Principal.USER &&
      context.iam.principal !== Principal.DISPLAY &&
      context.iam.principal !== Principal.APP)
  ) {
    throw new ORPCError("UNAUTHORIZED", { message: "Authentication required" });
  }

  return next({
    context: {
      iam: context.iam as GraphReadRPCContext["iam"],
    },
  });
});

// Display auth middleware - requires valid display authentication
const displayMiddleware = os.$context<RPCContext>().middleware(async ({ context, next }) => {
  if (!context.iam?.validToken || context.iam.principal !== Principal.DISPLAY) {
    throw new ORPCError("UNAUTHORIZED", { message: "Display authentication required" });
  }

  return next({
    context: {
      iam: context.iam as DisplayAuthenticatedRPCContext["iam"],
    },
  });
});

// Requires valid user authentication
export const userRequired = publicProcedure.use(userMiddleware);

// Backward-compatible alias for existing user-authenticated procedures
export const authRequired = userRequired;

// Requires a user or display principal
export const userOrDisplayRequired = publicProcedure.use(principalMiddleware);

// Requires a user, display, or app principal (graph read surface only)
export const graphReadRequired = publicProcedure.use(graphReadPrincipalMiddleware);

// Requires valid display authentication
export const displayRequired = publicProcedure.use(displayMiddleware);

function safeSecretEquals(expected: string, provided: string) {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

// Processor auth middleware - requires shared secret in Authorization header
const processorMiddleware = os.$context<RPCContext>().middleware(async ({ context, next }) => {
  const authorizationHeader = context.request.headers.authorization;

  if (!authorizationHeader || Array.isArray(authorizationHeader) || !authorizationHeader.startsWith("Processor ")) {
    throw new ORPCError("UNAUTHORIZED", { message: "Processor authorization required" });
  }

  if (!processorConfig.sharedSecret) {
    throw new ORPCError("FORBIDDEN", { message: "Processor ingest is not configured" });
  }

  const providedSecret = authorizationHeader.slice("Processor ".length);
  if (!safeSecretEquals(processorConfig.sharedSecret, providedSecret)) {
    throw new ORPCError("UNAUTHORIZED", { message: "Invalid processor secret" });
  }

  return next();
});

// Requires valid processor shared secret
export const processorRequired = publicProcedure.use(processorMiddleware);

// Permission-gated middleware factory. Uses the RBAC `hasPermission` check
// against the caller's workspaceId from the auth token.
//
// Replaces the old `adminRequired` / `ownerRequired` enum-based gates.
export const permissionRequired = (permission: import("@rw/auth/iam/index").Permission) => {
  const mw = os.$context<UserAuthenticatedRPCContext>().middleware(async ({ context, next }) => {
    const { hasPermission } = await import("@rw/auth/iam/index");
    const userId = context.iam.id;
    const workspaceId = context.iam.workspaceId;
    if (!userId || !workspaceId) {
      throw new ORPCError("UNAUTHORIZED", { message: "No workspace context" });
    }
    const ok = await hasPermission(userId, permission, {
      workspaceId,
      ...(context.iam.siteId ? { siteId: context.iam.siteId } : {}),
    });
    if (!ok) {
      throw new ORPCError("FORBIDDEN", { message: `Missing permission: ${permission}` });
    }
    return next();
  });
  return userRequired.use(mw);
};
