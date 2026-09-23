import {
  catalogGetInputSchema,
  catalogListInputSchema,
  idInputSchema,
  instanceCreateInputSchema,
  instanceListInputSchema,
  instanceUpdateInputSchema,
  listInputSchema,
  modelCreateInputSchema,
  modelFieldCreateInputSchema,
  modelFieldReorderInputSchema,
  modelFieldUpdateInputSchema,
  modelUpdateInputSchema,
} from "./entity.types.js";

import { ORPCError } from "@orpc/server";
import { type CodeOverrides, throwServiceError as throwServiceErrorShared, unwrap as unwrapService } from "./errors.js";
import * as entity from "@rw/services/entity/index";
import type { EntityScope } from "@rw/services/entity/index";
import type { Tier } from "@rw/auth/iam/access";
import type { CallerContext } from "./context.js";

import { userRequired } from "./middleware.js";

/**
 * entity.* keeps the token-site model: the active site comes from the
 * caller's switch-site token, never from input. Site presence is checked
 * before access so a missing site context does not leak whether the
 * caller holds the tier.
 */
async function tokenSite(context: CallerContext<"user">, tier: Tier): Promise<EntityScope> {
  const siteId = context.current.siteId;
  if (!siteId) throw new ORPCError("BAD_REQUEST", { message: "Site context required" });
  await context.access.require(tier, { site: siteId });
  return { workspaceId: context.current.workspaceId, siteId };
}

// Historical mapping in this router: scope mismatches are FORBIDDEN (the
// shared default is CONFLICT). Pinned for rpc-client back-compat.
const ENTITY_OVERRIDES: CodeOverrides = {
  SITE_MISMATCH: "FORBIDDEN",
  REF_SCHEMA_SITE_MISMATCH: "FORBIDDEN",
};

function unwrap<T>(result: { data: T } | { error: string; code: string } | null): T {
  return unwrapService(result, { overrides: ENTITY_OVERRIDES });
}

function throwServiceError(result: { error: string; code: string }): never {
  throwServiceErrorShared(result, ENTITY_OVERRIDES);
}

export const modelCreate = userRequired.input(modelCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "MANAGE");
  return unwrap(await entity.models.create(input, scope));
});

export const catalogList = userRequired.input(catalogListInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "VIEW");
  return entity.catalog.list(input, scope);
});

export const catalogGet = userRequired.input(catalogGetInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "VIEW");
  return unwrap(await entity.catalog.get(input, scope));
});

export const modelList = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "VIEW");
  return entity.models.list(input, scope);
});

export const modelGet = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "VIEW");
  return unwrap(await entity.models.getById(input.id, scope));
});

export const modelUpdate = userRequired.input(modelUpdateInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "MANAGE");
  const { id, ...updates } = input;
  return unwrap(await entity.models.update(id, updates, scope));
});

export const modelDelete = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "MANAGE");
  return unwrap(await entity.models.remove(input.id, scope));
});

export const modelFieldCreate = userRequired.input(modelFieldCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "MANAGE");
  return unwrap(await entity.models.createField(input, scope));
});

export const modelFieldUpdate = userRequired.input(modelFieldUpdateInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "MANAGE");
  const { id, ...updates } = input;
  return unwrap(await entity.models.updateField(id, updates, scope));
});

export const modelFieldDelete = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "MANAGE");
  return unwrap(await entity.models.removeField(input.id, scope));
});

export const modelFieldReorder = userRequired
  .input(modelFieldReorderInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await tokenSite(context, "MANAGE");
    return unwrap(await entity.models.reorderFields(input.schemaId, input.fieldIds, scope));
  });

export const instanceCreate = userRequired.input(instanceCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "MANAGE");
  const { name: _legacyName, ...instanceInput } = input;
  return unwrap(await entity.instances.create(instanceInput, scope));
});

export const instanceList = userRequired.input(instanceListInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "VIEW");
  const result = await entity.instances.list(input, scope);
  if ("error" in result) throwServiceError(result);
  return result;
});

export const instanceGet = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "VIEW");
  return unwrap(await entity.instances.getById(input.id, scope));
});

export const instanceUpdate = userRequired.input(instanceUpdateInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "MANAGE");
  const { id, name: _legacyName, ...updates } = input;
  return unwrap(await entity.instances.update(id, updates, scope));
});

export const instanceDelete = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await tokenSite(context, "MANAGE");
  return unwrap(await entity.instances.remove(input.id, scope));
});
