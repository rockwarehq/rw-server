import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { countActiveApiTokens, createApiToken, listApiTokens, revokeApiToken } from "@rw/auth/api-tokens";
import { logEvent } from "@rw/services/audit/index";

import { authRequired } from "./middleware.js";
import prisma from "@rw/db";
import { user } from "../services/account/index.js";
import { authorizePhysicalTarget as authorize } from "../api/authz.js";
import { grant } from "./authz.js";

// Customer token management is plant administration; APP scopes remain graph:read.

// Flooding guard: per-procedure rate limits don't apply inside the single oRPC
// route, so cap standing inventory instead.
const MAX_ACTIVE_TOKENS_PER_WORKSPACE = 50;

const createInputSchema = z.object({
  name: z.string().min(1).max(100),
  siteId: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
});

const revokeInputSchema = z.object({ id: z.uuid() });

function requireWorkspaceId(iam: { workspaceId?: string }): string {
  const workspaceId = iam.workspaceId;
  if (!workspaceId) throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  return workspaceId;
}

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const workspaceId = requireWorkspaceId(context.iam);
  grant(await authorize(context.iam, { permission: "plant:admin", scope: { kind: "site", siteId: input.siteId } }));

  const activeCount = await countActiveApiTokens(workspaceId);
  if (activeCount >= MAX_ACTIVE_TOKENS_PER_WORKSPACE) {
    throw new ORPCError("CONFLICT", {
      message: `Workspace has reached the limit of ${MAX_ACTIVE_TOKENS_PER_WORKSPACE} active API tokens`,
    });
  }

  const result = await createApiToken({
    name: input.name,
    workspaceId,
    siteId: input.siteId,
    createdById: context.iam.id,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
  });

  if ("error" in result) {
    throw new ORPCError("FORBIDDEN", { message: "Site does not belong to this workspace" });
  }

  await logEvent({
    action: "API_TOKEN_CREATED",
    actorId: context.iam.id,
    workspaceId,
    metadata: { tokenId: result.id, siteId: result.siteId, name: result.name },
  });

  // The plaintext token is returned exactly once, here. Only the hash is stored.
  return result;
});

export const list = authRequired.handler(async ({ context }) => {
  const scope = grant(await user.authorizePopulation(context.iam));
  const tokens = await listApiTokens(scope.workspaceId);
  return tokens.filter((token) => !scope.siteId || token.siteId === scope.siteId);
});

export const revoke = authRequired.input(revokeInputSchema).handler(async ({ input, context }) => {
  const workspaceId = requireWorkspaceId(context.iam);
  const token = await prisma.apiToken.findFirst({ where: { id: input.id, workspaceId }, select: { siteId: true } });
  if (!token) throw new ORPCError("NOT_FOUND", { message: "API token not found" });
  grant(
    await authorize(context.iam, {
      permission: "plant:admin",
      scope: token.siteId ? { kind: "site", siteId: token.siteId } : { kind: "workspace" },
    }),
  );

  const result = await revokeApiToken(input.id, workspaceId);
  if (!result) throw new ORPCError("NOT_FOUND", { message: "API token not found" });

  if (!result.alreadyRevoked) {
    await logEvent({
      action: "API_TOKEN_REVOKED",
      actorId: context.iam.id,
      workspaceId,
      metadata: { tokenId: input.id },
    });
  }

  return result;
});
