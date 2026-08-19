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
import { authorize } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";

import { authRequired } from "./middleware.js";

/**
 * entity.* keeps the token-site model: the active site comes from the
 * caller's switch-site token, never from input. Site presence is checked
 * before the permission so a missing site context does not leak whether
 * the caller holds the permission.
 */
function tokenSiteRef(iam: { siteId?: string | null }): { kind: "site"; siteId: string } {
  if (!iam.siteId)
    throw new ORPCError("BAD_REQUEST", {
      message: "Site context required",
    });
  return { kind: "site", siteId: iam.siteId };
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

export const modelCreate = authRequired.input(modelCreateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
  return unwrap(await entity.models.create(input, scope));
});

export const catalogList = authRequired.input(catalogListInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:read", scope: tokenSiteRef(context.iam) }));
  return entity.catalog.list(input, scope);
});

export const catalogGet = authRequired.input(catalogGetInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:read", scope: tokenSiteRef(context.iam) }));
  return unwrap(await entity.catalog.get(input, scope));
});

export const modelList = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:read", scope: tokenSiteRef(context.iam) }));
  return entity.models.list(input, scope);
});

export const modelGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:read", scope: tokenSiteRef(context.iam) }));
  return unwrap(await entity.models.getById(input.id, scope));
});

export const modelUpdate = authRequired.input(modelUpdateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
  const { id, ...updates } = input;
  return unwrap(await entity.models.update(id, updates, scope));
});

export const modelDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
  return unwrap(await entity.models.remove(input.id, scope));
});

export const modelFieldCreate = authRequired.input(modelFieldCreateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
  return unwrap(await entity.models.createField(input, scope));
});

export const modelFieldUpdate = authRequired.input(modelFieldUpdateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
  const { id, ...updates } = input;
  return unwrap(await entity.models.updateField(id, updates, scope));
});

export const modelFieldDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
  return unwrap(await entity.models.removeField(input.id, scope));
});

export const modelFieldReorder = authRequired
  .input(modelFieldReorderInputSchema)
  .handler(async ({ input, context }) => {
    const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
    return unwrap(await entity.models.reorderFields(input.schemaId, input.fieldIds, scope));
  });

export const instanceCreate = authRequired.input(instanceCreateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
  const { name: _legacyName, ...instanceInput } = input;
  return unwrap(await entity.instances.create(instanceInput, scope));
});

export const instanceList = authRequired.input(instanceListInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:read", scope: tokenSiteRef(context.iam) }));
  const result = await entity.instances.list(input, scope);
  if ("error" in result) throwServiceError(result);
  return result;
});

export const instanceGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:read", scope: tokenSiteRef(context.iam) }));
  return unwrap(await entity.instances.getById(input.id, scope));
});

export const instanceUpdate = authRequired.input(instanceUpdateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
  const { id, name: _legacyName, ...updates } = input;
  return unwrap(await entity.instances.update(id, updates, scope));
});

export const instanceDelete = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorize(context.iam, { permission: "entity:write", scope: tokenSiteRef(context.iam) }));
  return unwrap(await entity.instances.remove(input.id, scope));
});
