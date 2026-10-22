import { ORPCError } from "@orpc/server";
import prisma from "@rw/db";
import { logEvent } from "@rw/services/audit/index";
import { z } from "zod";

import { mcpConfig } from "../config.js";
import { redirectWith, verifyAuthorizationRequest, type AuthorizationRequest } from "../oauth/request.js";
import { createGrantWithCode, findClient, normalizeScopes, OAUTH_SCOPES, revokeGrant } from "../oauth/store.js";
import { userRequired } from "./middleware.js";
import type { CallerContext } from "./context.js";

// People connecting their own agents (OAuth over MCP), from IMM:
// - the consent page reads the authorization request and approves or
//   denies it (approve creates the grant and the code the agent exchanges);
// - Connected agents lists and revokes grants;
// - plant ADMINs turn agent connections on or off for their plant.
//
// None of these are callable by a connected agent itself: they are not in
// AGENT_CALLABLE.

type UserContext = CallerContext<"user">;

function requireConnections() {
  if (!mcpConfig.connections) throw new ORPCError("NOT_FOUND", { message: "Agent connections aren't available" });
}

function requestFrom(handle: string): AuthorizationRequest {
  const request = verifyAuthorizationRequest(handle);
  if (!request) {
    throw new ORPCError("BAD_REQUEST", { message: "This connection request expired. Start again from your agent." });
  }
  return request;
}

/** Scopes this person may grant at this site: propose needs MANAGE there (never SUPPORT staff). */
function grantableScopes(context: UserContext, siteId: string): string[] {
  const canPropose = context.access.can("MANAGE", { site: siteId }) && context.access.person.staff !== "SUPPORT";
  return canPropose ? [...OAUTH_SCOPES] : ["read"];
}

const handleInput = z.object({ request: z.string().min(1).max(4000) });

export const describeRequest = userRequired.input(handleInput).handler(async ({ input, context }) => {
  requireConnections();
  const request = requestFrom(input.request);
  const client = await findClient(request.clientId);
  if (!client) throw new ORPCError("BAD_REQUEST", { message: "Unknown agent. Start again from your agent." });

  const visible = context.access.sites();
  const sites = await prisma.site.findMany({
    where: {
      workspaceId: context.current.workspaceId,
      ...(visible === "all" ? {} : { id: { in: visible } }),
    },
    select: { id: true, name: true, agentConnections: true },
    orderBy: { name: "asc" },
  });

  return {
    client: { name: client.name, redirectHost: new URL(request.redirectUri).host },
    requestedScopes: request.scopes,
    staff: context.access.person.staff,
    sites: sites.map((site) => ({
      id: site.id,
      name: site.name,
      agentConnections: site.agentConnections,
      grantableScopes: grantableScopes(context, site.id),
    })),
  };
});

export const approve = userRequired
  .input(handleInput.extend({ siteId: z.uuid(), scopes: z.array(z.enum(OAUTH_SCOPES)).min(1) }))
  .handler(async ({ input, context }) => {
    requireConnections();
    const request = requestFrom(input.request);
    const client = await findClient(request.clientId);
    if (!client) throw new ORPCError("BAD_REQUEST", { message: "Unknown agent. Start again from your agent." });

    await context.access.require("VIEW", { site: input.siteId });
    const site = await prisma.site.findFirst({
      where: { id: input.siteId, workspaceId: context.current.workspaceId },
      select: { id: true, agentConnections: true },
    });
    if (!site) throw new ORPCError("NOT_FOUND", { message: "Plant not found" });
    if (!site.agentConnections) {
      throw new ORPCError("FORBIDDEN", { message: "Agent connections are turned off for this plant" });
    }

    const scopes = normalizeScopes(input.scopes);
    const grantable = grantableScopes(context, site.id);
    if (scopes.some((scope) => !grantable.includes(scope))) {
      throw new ORPCError("FORBIDDEN", { message: "You can't give an agent more access than you have here" });
    }

    const { grantId, code } = await createGrantWithCode({
      userId: context.current.user.id,
      workspaceId: context.current.workspaceId,
      siteId: site.id,
      clientId: client.id,
      scopes,
      codeChallenge: request.codeChallenge,
      redirectUri: request.redirectUri,
    });

    await logEvent({
      action: "OAUTH_GRANT_CREATED",
      actorId: context.current.user.id,
      workspaceId: context.current.workspaceId,
      metadata: {
        grantId,
        siteId: site.id,
        clientId: client.id,
        clientName: client.name,
        scopes,
        staff: context.access.person.staff,
      },
    });

    return { redirectTo: redirectWith(request.redirectUri, { code, state: request.state }) };
  });

export const deny = userRequired.input(handleInput).handler(async ({ input }) => {
  requireConnections();
  const request = requestFrom(input.request);
  return {
    redirectTo: redirectWith(request.redirectUri, {
      error: "access_denied",
      error_description: "The person declined the connection",
      state: request.state,
    }),
  };
});

/** Live connections at a site: your own, or everyone's for a plant ADMIN. */
export const list = userRequired.input(z.object({ siteId: z.uuid() })).handler(async ({ input, context }) => {
  requireConnections();
  await context.access.require("VIEW", { site: input.siteId });
  const admin = context.access.can("ADMIN", { site: input.siteId });
  const grants = await prisma.oAuthGrant.findMany({
    where: {
      siteId: input.siteId,
      revokedAt: null,
      ...(admin ? {} : { userId: context.current.user.id }),
    },
    select: {
      id: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      client: { select: { name: true } },
      user: { select: { id: true, firstName: true, lastName: true, email: true, systemRole: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return {
    canManageAll: admin,
    data: grants.map((grant) => ({
      id: grant.id,
      clientName: grant.client.name,
      scopes: normalizeScopes(grant.scopes),
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
      mine: grant.user.id === context.current.user.id,
      user: {
        id: grant.user.id,
        name: [grant.user.firstName, grant.user.lastName].filter(Boolean).join(" ") || grant.user.email,
        staff: grant.user.systemRole !== null,
      },
    })),
  };
});

export const revoke = userRequired.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  requireConnections();
  const grant = await prisma.oAuthGrant.findFirst({
    where: { id: input.id, workspaceId: context.current.workspaceId },
    select: { id: true, userId: true, siteId: true, client: { select: { name: true } } },
  });
  if (!grant) throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
  if (grant.userId !== context.current.user.id) {
    await context.access.require("ADMIN", { site: grant.siteId });
  }
  await revokeGrant(grant.id);
  await logEvent({
    action: "OAUTH_GRANT_REVOKED",
    actorId: context.current.user.id,
    userId: grant.userId,
    workspaceId: context.current.workspaceId,
    metadata: { grantId: grant.id, siteId: grant.siteId, clientName: grant.client.name },
  });
  return { ok: true };
});

export const policy = userRequired.input(z.object({ siteId: z.uuid() })).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });
  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { agentConnections: true } });
  if (!site) throw new ORPCError("NOT_FOUND", { message: "Plant not found" });
  return {
    available: mcpConfig.connections,
    enabled: site.agentConnections,
    canChange: context.access.can("ADMIN", { site: input.siteId }),
  };
});

// Turning it off refuses every connected agent at once (checked on each MCP
// request) but keeps the grants, so turning it back on restores them.
// Revoke individual connections to end them for good.
export const setPolicy = userRequired
  .input(z.object({ siteId: z.uuid(), enabled: z.boolean() }))
  .handler(async ({ input, context }) => {
    requireConnections();
    await context.access.require("ADMIN", { site: input.siteId });
    const site = await prisma.site.update({
      where: { id: input.siteId },
      data: { agentConnections: input.enabled },
      select: { agentConnections: true },
    });
    await logEvent({
      action: "AGENT_CONNECTIONS_POLICY_CHANGED",
      actorId: context.current.user.id,
      workspaceId: context.current.workspaceId,
      metadata: { siteId: input.siteId, enabled: input.enabled, staff: context.access.person.staff },
    });
    return { enabled: site.agentConnections };
  });
