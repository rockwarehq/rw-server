import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { hasPermission, type Permission } from "@rw/auth/iam/index";
import { buildIntegrationCatalog, createDefaultIntegrationRegistry } from "@rw/integrations";
import { integrations } from "@rw/services/integration/index";
import * as graph from "@rw/livestore/graph/index";
import type { GraphScope } from "@rw/livestore/graph/types";

import { unwrap as unwrapService } from "./errors.js";
import { authRequired } from "./middleware.js";

// Integrations hold credentials and a trigger decides when those credentials get
// used, so both sit behind settings:admin (the ApiToken precedent) rather than
// graph:write.
const INTEGRATION_PERMISSION: Permission = "settings:admin";

const registry = createDefaultIntegrationRegistry();
const catalog = buildIntegrationCatalog(registry);

const jsonObjectSchema = z.record(z.string(), z.unknown());
const idInputSchema = z.object({ id: z.uuid() });

type AuthContext = {
  iam: { principal?: string; id?: string; workspaceId?: string | null; siteId?: string | null };
};

function unwrap<T>(result: { data: T } | { error: string; code: string } | null): T {
  return unwrapService(result);
}

async function assertSite(context: AuthContext, siteId: string): Promise<GraphScope> {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  const userId = context.iam.id;
  if (!userId) throw new ORPCError("UNAUTHORIZED", { message: "Authentication required" });

  const ok = await hasPermission(userId, INTEGRATION_PERMISSION, { workspaceId, siteId });
  if (!ok) throw new ORPCError("FORBIDDEN", { message: `Missing permission: ${INTEGRATION_PERMISSION}` });
  return { workspaceId, siteId };
}

// ============================================================================
// Integrations
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  type: z.string().min(1),
  enabled: z.boolean().optional(),
  config: jsonObjectSchema,
  secret: jsonObjectSchema.optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: jsonObjectSchema.optional(),
  // Omit to keep the stored secret, null to clear it, an object to replace it.
  secret: jsonObjectSchema.nullish(),
});

const listInputSchema = z.object({
  siteId: z.uuid(),
  type: z.string().optional(),
  enabled: z.boolean().optional(),
  limit: z.number().int().min(0).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

const scopedIdInputSchema = idInputSchema.extend({ siteId: z.uuid() });

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...rest } = input;
  const scope = await assertSite(context, siteId);
  return unwrap(await integrations.create(rest, scope));
});

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...filter } = input;
  const scope = await assertSite(context, siteId);
  return integrations.list(filter, scope);
});

export const get = authRequired.input(scopedIdInputSchema).handler(async ({ input, context }) => {
  const scope = await assertSite(context, input.siteId);
  return unwrap(await integrations.getById(input.id, scope));
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, siteId, ...updates } = input;
  const scope = await assertSite(context, siteId);
  return unwrap(await integrations.update(id, updates, scope));
});

export const remove = authRequired.input(scopedIdInputSchema).handler(async ({ input, context }) => {
  const scope = await assertSite(context, input.siteId);
  return unwrap(await integrations.remove(input.id, scope));
});

/** Static per deploy: type list, config/secret JSON Schemas, action inputs. */
export const typeCatalog = authRequired.handler(async () => ({ data: catalog }));

// ============================================================================
// Triggers
// ============================================================================

const triggerCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  eventNamespace: z.string().min(1),
  eventName: z.string().min(1),
  eventVersion: z.string().min(1).optional(),
  hookId: z.uuid().nullish(),
  integrationId: z.uuid(),
  actionKey: z.string().min(1),
  actionVersion: z.string().min(1).optional(),
  input: jsonObjectSchema,
});

const triggerUpdateInputSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  eventNamespace: z.string().min(1).optional(),
  eventName: z.string().min(1).optional(),
  eventVersion: z.string().min(1).optional(),
  hookId: z.uuid().nullish(),
  integrationId: z.uuid().optional(),
  actionKey: z.string().min(1).optional(),
  actionVersion: z.string().min(1).optional(),
  input: jsonObjectSchema.optional(),
});

const triggerListInputSchema = z.object({
  siteId: z.uuid(),
  integrationId: z.uuid().optional(),
  hookId: z.uuid().optional(),
  enabled: z.boolean().optional(),
  limit: z.number().int().min(0).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

export const triggerCreate = authRequired.input(triggerCreateInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...rest } = input;
  const scope = await assertSite(context, siteId);
  return unwrap(await graph.triggers.create(rest, scope));
});

export const triggerList = authRequired.input(triggerListInputSchema).handler(async ({ input, context }) => {
  const { siteId, ...filter } = input;
  const scope = await assertSite(context, siteId);
  return graph.triggers.list(filter, scope);
});

export const triggerGet = authRequired.input(scopedIdInputSchema).handler(async ({ input, context }) => {
  const scope = await assertSite(context, input.siteId);
  return unwrap(await graph.triggers.getById(input.id, scope));
});

export const triggerUpdate = authRequired.input(triggerUpdateInputSchema).handler(async ({ input, context }) => {
  const { id, siteId, ...updates } = input;
  const scope = await assertSite(context, siteId);
  return unwrap(await graph.triggers.update(id, updates, scope));
});

export const triggerDelete = authRequired.input(scopedIdInputSchema).handler(async ({ input, context }) => {
  const scope = await assertSite(context, input.siteId);
  return unwrap(await graph.triggers.remove(input.id, scope));
});
