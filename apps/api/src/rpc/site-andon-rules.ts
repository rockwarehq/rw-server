import { z } from "zod";
import { site } from "@rw/services/facility/index";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { authorize } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { throwServiceError } from "./errors.js";

const andonRuleInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().nullable().optional(),
  expression: z.string(),
  referencedVariables: z.array(z.string()),
  colorHex: z.string(),
  enabled: z.boolean().optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable().optional(),
  expression: z.string().optional(),
  referencedVariables: z.array(z.string()).optional(),
  colorHex: z.string().optional(),
  enabled: z.boolean().optional(),
});

const deleteInputSchema = z.object({
  id: z.uuid(),
});

const reorderInputSchema = z.object({
  siteId: z.uuid(),
  orderedIds: z.array(z.uuid()),
});

function hasAndonRuleError(result: unknown): result is { error: string; code: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof result.error === "string" &&
    "code" in result &&
    typeof result.code === "string"
  );
}

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:read", scope: { kind: "site", siteId: input.siteId } }),
  );

  const result = await site.andonRules.list(input, workspaceId);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return result.data;
});

export const create = authRequired.input(andonRuleInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", scope: { kind: "site", siteId: input.siteId } }),
  );

  const result = await site.andonRules.create(input, workspaceId);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return result.data;
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", scope: { kind: "siteAndonRule", id: input.id } }),
  );

  const result = await site.andonRules.update(input, workspaceId);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return result.data;
});

export const remove = authRequired.input(deleteInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", scope: { kind: "siteAndonRule", id: input.id } }),
  );

  const result = await site.andonRules.remove(input.id, workspaceId);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return { success: true };
});

export const reorder = authRequired.input(reorderInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(
    await authorize(context.iam, { permission: "facility:write", scope: { kind: "site", siteId: input.siteId } }),
  );

  const result = await site.andonRules.reorder(input, workspaceId);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return { success: true };
});
