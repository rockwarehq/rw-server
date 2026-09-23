import { z } from "zod";
import { site } from "@rw/services/facility/index";
import { userRequired, userOrDisplayRequired } from "./middleware.js";
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
  await context.access.require("VIEW", { site: input.siteId });

  const result = await site.andonRules.list(input);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return result.data;
});

export const create = userRequired.input(andonRuleInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  const result = await site.andonRules.create(input);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return result.data;
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { siteAndonRule: input.id });

  const result = await site.andonRules.update(input);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return result.data;
});

export const remove = userRequired.input(deleteInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { siteAndonRule: input.id });

  const result = await site.andonRules.remove(input.id);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return { success: true };
});

export const reorder = userRequired.input(reorderInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  const result = await site.andonRules.reorder(input);
  if (hasAndonRuleError(result)) {
    throwServiceError(result);
  }

  return { success: true };
});
