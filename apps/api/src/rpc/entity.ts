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
  type AuthContext,
} from "./entity.types.js";

import { ORPCError } from "@orpc/server";
import * as entity from "@rw/services/entity/index";
import type { EntityScope } from "@rw/services/entity/index";
import { hasPermission, type Permission } from "@rw/auth/iam/index";

import { authRequired } from "./middleware.js";

async function assertPermission(context: AuthContext, permission: Permission): Promise<EntityScope> {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId)
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  const ok = await hasPermission(context.iam.id, permission, {
    workspaceId,
    ...(context.iam.siteId ? { siteId: context.iam.siteId } : {}),
  });
  if (!ok)
    throw new ORPCError("FORBIDDEN", {
      message: `Missing permission: ${permission}`,
    });
  const siteId = context.iam.siteId;
  if (!siteId)
    throw new ORPCError("BAD_REQUEST", {
      message: "Site context required",
    });
  return { workspaceId, siteId };
}

function throwServiceError(result: { error: string; code: string }): never {
  if (result.code.includes("NOT_FOUND")) throw new ORPCError("NOT_FOUND", { message: result.error, cause: result });
  if (result.code.includes("MISMATCH")) throw new ORPCError("FORBIDDEN", { message: result.error, cause: result });
  if (result.code.includes("EXISTS")) throw new ORPCError("CONFLICT", { message: result.error, cause: result });
  throw new ORPCError("BAD_REQUEST", { message: result.error, cause: result });
}

function unwrap<T>(result: { data: T } | { error: string; code: string } | null): T {
  if (!result) throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
  if ("error" in result) throwServiceError(result);
  return result.data;
}

export const modelCreate = authRequired.input(modelCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:write");
  return unwrap(await entity.models.create(input, scope));
});

export const catalogList = authRequired.input(catalogListInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:read");
  return entity.catalog.list(input, scope);
});

export const catalogGet = authRequired.input(catalogGetInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:read");
  return unwrap(await entity.catalog.get(input, scope));
});

export const modelList = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:read");
  return entity.models.list(input, scope);
});

export const modelGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:read");
  return unwrap(await entity.models.getById(input.id, scope));
});

export const modelUpdate = authRequired.input(modelUpdateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:write");
  const { id, ...updates } = input;
  return unwrap(await entity.models.update(id, updates, scope));
});

export const modelDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:write");
  return unwrap(await entity.models.remove(input.id, scope));
});

export const modelFieldCreate = authRequired.input(modelFieldCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:write");
  return unwrap(await entity.models.createField(input, scope));
});

export const modelFieldUpdate = authRequired.input(modelFieldUpdateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:write");
  const { id, ...updates } = input;
  return unwrap(await entity.models.updateField(id, updates, scope));
});

export const modelFieldDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:write");
  return unwrap(await entity.models.removeField(input.id, scope));
});

export const modelFieldReorder = authRequired
  .input(modelFieldReorderInputSchema)
  .handler(async ({ input, context }) => {
    const scope = await assertPermission(context, "entity:write");
    return unwrap(await entity.models.reorderFields(input.schemaId, input.fieldIds, scope));
  });

export const instanceCreate = authRequired.input(instanceCreateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:write");
  const { name: _legacyName, ...instanceInput } = input;
  return unwrap(await entity.instances.create(instanceInput, scope));
});

export const instanceList = authRequired.input(instanceListInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:read");
  const result = await entity.instances.list(input, scope);
  if ("error" in result) throwServiceError(result);
  return result;
});

export const instanceGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:read");
  return unwrap(await entity.instances.getById(input.id, scope));
});

export const instanceUpdate = authRequired.input(instanceUpdateInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:write");
  const { id, name: _legacyName, ...updates } = input;
  return unwrap(await entity.instances.update(id, updates, scope));
});

export const instanceDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = await assertPermission(context, "entity:write");
  return unwrap(await entity.instances.remove(input.id, scope));
});
