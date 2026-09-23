import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { countActiveApiTokens, createApiToken, listApiTokens, revokeApiToken } from "@rw/auth/api-tokens";
import { logEvent } from "@rw/services/audit/index";

import { userRequired } from "./middleware.js";

// A token reads one site's data, so creating one is plant ADMIN at that
// site. Listing and revoking see every token in the workspace, so they are
// for the owner.

// Flooding guard: per-procedure rate limits don't apply inside the single oRPC
// route, so cap standing inventory instead.
const MAX_ACTIVE_TOKENS_PER_WORKSPACE = 50;

const createInputSchema = z.object({
  name: z.string().min(1).max(100),
  siteId: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
});

const revokeInputSchema = z.object({ id: z.uuid() });

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });
  const { workspaceId } = context.current;

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
    createdById: context.current.user.id,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
  });

  if ("error" in result) {
    throw new ORPCError("FORBIDDEN", { message: "Site does not belong to this workspace" });
  }

  await logEvent({
    action: "API_TOKEN_CREATED",
    actorId: context.current.user.id,
    workspaceId,
    metadata: { tokenId: result.id, siteId: result.siteId, name: result.name },
  });

  // The plaintext token is returned exactly once, here. Only the hash is stored.
  return result;
});

export const list = userRequired.handler(async ({ context }) => {
  context.access.requireAccountAdmin();
  return listApiTokens(context.current.workspaceId);
});

export const revoke = userRequired.input(revokeInputSchema).handler(async ({ input, context }) => {
  context.access.requireAccountAdmin();
  const { workspaceId } = context.current;

  const result = await revokeApiToken(input.id, workspaceId);
  if (!result) throw new ORPCError("NOT_FOUND", { message: "API token not found" });

  if (!result.alreadyRevoked) {
    await logEvent({
      action: "API_TOKEN_REVOKED",
      actorId: context.current.user.id,
      workspaceId,
      metadata: { tokenId: input.id },
    });
  }

  return result;
});
