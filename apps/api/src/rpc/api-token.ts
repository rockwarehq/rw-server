import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { countActiveApiTokens, createApiToken, listApiTokens, revokeApiToken } from "@rw/auth/api-tokens";
import { logEvent } from "@rw/services/audit/index";

import { permissionRequired } from "./middleware.js";

// Workspace integration credentials are settings-level configuration, so token
// management rides the existing settings:admin permission rather than a new
// resource (revisit if tokens grow scopes beyond graph:read).
const apiTokenAdminRequired = permissionRequired("settings:admin");

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

export const create = apiTokenAdminRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const workspaceId = requireWorkspaceId(context.iam);

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

export const list = apiTokenAdminRequired.handler(async ({ context }) => {
  const workspaceId = requireWorkspaceId(context.iam);
  return listApiTokens(workspaceId);
});

export const revoke = apiTokenAdminRequired.input(revokeInputSchema).handler(async ({ input, context }) => {
  const workspaceId = requireWorkspaceId(context.iam);

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
