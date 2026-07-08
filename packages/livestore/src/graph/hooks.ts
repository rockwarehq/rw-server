import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import {
  LIVESTORE_HOOK_EVENT_CATALOG,
  getLivestoreHookEventSchema,
  normalizeLivestoreEventToken,
  normalizeLivestoreEventVersion,
  type LivestoreHookEventSchema,
} from "../catalog/events.js";
import {
  graphHookConditionPropertyIds,
  graphHookEventContextPropertyIds,
  parseGraphHookCondition,
  parseGraphHookEventContext,
  type GraphHookCondition,
  type GraphHookEventContext,
} from "../catalog/hook-conditions.js";

import { publishGraphDefinitionEvent } from "./definition-events.js";
import { graphNodeSiteWhere, getGraphSiteForWorkspace, nodeBelongsToSite } from "./scope.js";
import { errorResult, type GraphScope, type ListResult, type ServiceResult } from "./types.js";

export interface CreateGraphHookInput {
  siteId?: string;
  name: string;
  enabled?: boolean;
  condition: Record<string, unknown>;
  eventNamespace: string;
  eventName: string;
  eventVersion?: string;
  eventPayload?: Record<string, unknown>;
  eventContext?: Record<string, unknown>;
}

export interface UpdateGraphHookInput {
  name?: string;
  enabled?: boolean;
  condition?: Record<string, unknown>;
  eventNamespace?: string;
  eventName?: string;
  eventVersion?: string;
  eventPayload?: Record<string, unknown>;
  eventContext?: Record<string, unknown>;
}

export interface ListGraphHooksFilter {
  name?: string;
  enabled?: boolean;
  eventNamespace?: string;
  eventName?: string;
  limit?: number;
  offset?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getGraphHookForSite(id: string, scope: GraphScope) {
  const hook = await prisma.graphHook.findUnique({
    where: { id },
    include: { site: true },
  });
  if (!hook) return null;
  if (!nodeBelongsToSite(hook, scope)) return errorResult("SITE_MISMATCH", "Graph hook does not belong to this site");
  if (hook.isDeleted) return errorResult("GRAPH_HOOK_DELETED", "Graph hook has been deleted");
  return { data: hook };
}

async function assertHookCondition(input: unknown, scope: GraphScope) {
  const condition = parseGraphHookCondition(input);
  if (!condition) return errorResult("INVALID_HOOK_CONDITION", "Graph hook condition is invalid");

  const propertyIds = graphHookConditionPropertyIds(condition);
  const properties = await prisma.graphProperty.findMany({
    where: {
      id: { in: propertyIds },
      isDeleted: false,
      node: graphNodeSiteWhere(scope),
    },
    select: { id: true },
  });
  if (properties.length !== propertyIds.length) {
    return errorResult("HOOK_PROPERTY_NOT_FOUND", "One or more hook condition properties were not found");
  }

  return { data: condition };
}

async function assertPropertyIdsInSite(propertyIds: readonly string[], scope: GraphScope) {
  const ids = [...new Set(propertyIds)];
  if (ids.length === 0) return { data: true as const };
  const properties = await prisma.graphProperty.findMany({
    where: {
      id: { in: ids },
      isDeleted: false,
      node: graphNodeSiteWhere(scope),
    },
    select: { id: true },
  });
  if (properties.length !== ids.length) {
    return errorResult("HOOK_PROPERTY_NOT_FOUND", "One or more hook referenced properties were not found");
  }
  return { data: true as const };
}

function validateEvent(namespace: string, name: string, version: string) {
  let eventNamespace: string;
  let eventName: string;
  let eventVersion: string;
  try {
    eventNamespace = normalizeLivestoreEventToken(namespace);
    eventName = normalizeLivestoreEventToken(name);
    eventVersion = normalizeLivestoreEventVersion(version);
  } catch (err) {
    return errorResult("INVALID_HOOK_EVENT", err instanceof Error ? err.message : "Graph hook event is invalid");
  }
  const schema = getLivestoreHookEventSchema(eventNamespace, eventName, eventVersion);
  if (!schema) {
    return errorResult(
      "UNKNOWN_HOOK_EVENT",
      `Unknown LiveStore hook event: ${eventNamespace}.${eventName}@${eventVersion}`,
    );
  }
  return { data: { eventNamespace, eventName, eventVersion, schema } };
}

function validatePayload(payload: unknown) {
  if (payload === undefined) return { data: {} as Record<string, unknown> };
  if (!isRecord(payload)) return errorResult("INVALID_HOOK_PAYLOAD", "Graph hook eventPayload must be an object");
  return { data: payload };
}

async function validateEventContext(input: unknown, eventSchema: LivestoreHookEventSchema, scope: GraphScope) {
  const context = parseGraphHookEventContext(input);
  if (!context) return errorResult("INVALID_HOOK_CONTEXT", "Graph hook eventContext is invalid");

  const fields = eventSchema.contextFields;
  for (const field of Object.keys(context)) {
    const schema = fields[field];
    if (!schema)
      return errorResult(
        "UNKNOWN_HOOK_CONTEXT_FIELD",
        `Unknown context field for ${eventSchema.namespace}.${eventSchema.name}: ${field}`,
      );
    if (!schema.sourceTypes.includes(context[field].source.type)) {
      return errorResult(
        "INVALID_HOOK_CONTEXT_SOURCE",
        `Context field ${field} does not allow source type ${context[field].source.type}`,
      );
    }
  }

  for (const [field, schema] of Object.entries(fields)) {
    if (schema.required && !context[field]) {
      return errorResult("MISSING_HOOK_CONTEXT_FIELD", `Required context field is missing: ${field}`);
    }
  }

  const propertyResult = await assertPropertyIdsInSite(graphHookEventContextPropertyIds(context), scope);
  if ("error" in propertyResult) return propertyResult;

  return { data: context };
}

function hookReferencedPropertyIds(condition: GraphHookCondition, context: GraphHookEventContext): string[] {
  return [...graphHookConditionPropertyIds(condition), ...graphHookEventContextPropertyIds(context)];
}

export async function create(input: CreateGraphHookInput, scope: GraphScope): Promise<ServiceResult<unknown>> {
  const name = input.name.trim();
  if (!name) return errorResult("INVALID_NAME", "Graph hook name is required");

  const siteResult = await getGraphSiteForWorkspace(scope.siteId, scope.workspaceId);
  if ("error" in siteResult) return siteResult;

  if (input.siteId && input.siteId !== scope.siteId) {
    return errorResult("SITE_MISMATCH", "Graph hook siteId does not match the scoped site");
  }

  const conditionResult = await assertHookCondition(input.condition, scope);
  if ("error" in conditionResult) return conditionResult;

  const eventResult = validateEvent(input.eventNamespace, input.eventName, input.eventVersion ?? "1");
  if ("error" in eventResult) return eventResult;

  const payloadResult = validatePayload(input.eventPayload);
  if ("error" in payloadResult) return payloadResult;

  const contextResult = await validateEventContext(input.eventContext, eventResult.data.schema, scope);
  if ("error" in contextResult) return contextResult;

  const existing = await prisma.graphHook.findUnique({ where: { siteId_name: { siteId: scope.siteId, name } } });
  if (existing && !existing.isDeleted) return errorResult("GRAPH_HOOK_NAME_EXISTS", "Graph hook name already exists");

  const hook = existing
    ? await prisma.graphHook.update({
        where: { id: existing.id },
        data: {
          name,
          siteId: scope.siteId,
          enabled: input.enabled ?? true,
          condition: conditionResult.data as unknown as Prisma.InputJsonValue,
          eventNamespace: eventResult.data.eventNamespace,
          eventName: eventResult.data.eventName,
          eventVersion: eventResult.data.eventVersion,
          eventPayload: payloadResult.data as Prisma.InputJsonValue,
          eventContext: contextResult.data as unknown as Prisma.InputJsonValue,
          isDeleted: false,
        },
      })
    : await prisma.graphHook.create({
        data: {
          siteId: scope.siteId,
          name,
          enabled: input.enabled ?? true,
          condition: conditionResult.data as unknown as Prisma.InputJsonValue,
          eventNamespace: eventResult.data.eventNamespace,
          eventName: eventResult.data.eventName,
          eventVersion: eventResult.data.eventVersion,
          eventPayload: payloadResult.data as Prisma.InputJsonValue,
          eventContext: contextResult.data as unknown as Prisma.InputJsonValue,
        },
      });

  publishGraphDefinitionEvent({
    entity: "hook",
    action: "created",
    entityId: hook.id,
    siteId: scope.siteId,
  });

  return { data: hook };
}

export async function update(
  id: string,
  input: UpdateGraphHookInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const currentResult = await getGraphHookForSite(id, scope);
  if (!currentResult) return errorResult("GRAPH_HOOK_NOT_FOUND", "Graph hook not found");
  if ("error" in currentResult) return currentResult;
  const current = currentResult.data;

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return errorResult("INVALID_NAME", "Graph hook name is required");
    if (name !== current.name) {
      const conflict = await prisma.graphHook.findUnique({ where: { siteId_name: { siteId: scope.siteId, name } } });
      if (conflict) return errorResult("GRAPH_HOOK_NAME_EXISTS", "Graph hook name already exists");
    }
    data.name = name;
  }

  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.condition !== undefined) {
    const conditionResult = await assertHookCondition(input.condition, scope);
    if ("error" in conditionResult) return conditionResult;
    data.condition = conditionResult.data as unknown as Prisma.InputJsonValue;
  }

  const eventNamespace = input.eventNamespace ?? current.eventNamespace;
  const eventName = input.eventName ?? current.eventName;
  const eventVersion = input.eventVersion ?? current.eventVersion;
  let eventSchema: LivestoreHookEventSchema | null = getLivestoreHookEventSchema(
    eventNamespace,
    eventName,
    eventVersion,
  );
  if (input.eventNamespace !== undefined || input.eventName !== undefined || input.eventVersion !== undefined) {
    const eventResult = validateEvent(eventNamespace, eventName, eventVersion);
    if ("error" in eventResult) return eventResult;
    data.eventNamespace = eventResult.data.eventNamespace;
    data.eventName = eventResult.data.eventName;
    data.eventVersion = eventResult.data.eventVersion;
    eventSchema = eventResult.data.schema;
  }
  if (!eventSchema)
    return errorResult(
      "UNKNOWN_HOOK_EVENT",
      `Unknown LiveStore hook event: ${eventNamespace}.${eventName}@${eventVersion}`,
    );

  if (input.eventPayload !== undefined) {
    const payloadResult = validatePayload(input.eventPayload);
    if ("error" in payloadResult) return payloadResult;
    data.eventPayload = payloadResult.data as Prisma.InputJsonValue;
  }

  if (
    input.eventContext !== undefined ||
    input.eventNamespace !== undefined ||
    input.eventName !== undefined ||
    input.eventVersion !== undefined
  ) {
    const contextResult = await validateEventContext(input.eventContext ?? current.eventContext, eventSchema, scope);
    if ("error" in contextResult) return contextResult;
    data.eventContext = contextResult.data as unknown as Prisma.InputJsonValue;
  }

  if (Object.keys(data).length === 0) return { data: current };

  const hook = await prisma.graphHook.update({ where: { id }, data });
  publishGraphDefinitionEvent({
    entity: "hook",
    action: "updated",
    entityId: hook.id,
    siteId: scope.siteId,
  });

  return { data: hook };
}

export async function remove(id: string, scope: GraphScope): Promise<ServiceResult<{ success: true }>> {
  const currentResult = await getGraphHookForSite(id, scope);
  if (!currentResult) return errorResult("GRAPH_HOOK_NOT_FOUND", "Graph hook not found");
  if ("error" in currentResult) return currentResult;

  await prisma.graphHook.update({ where: { id }, data: { isDeleted: true } });
  publishGraphDefinitionEvent({
    entity: "hook",
    action: "deleted",
    entityId: id,
    siteId: scope.siteId,
  });

  return { data: { success: true } };
}

export async function getById(id: string, scope: GraphScope): Promise<ServiceResult<unknown> | null> {
  return getGraphHookForSite(id, scope);
}

export async function getSiteId(id: string, workspaceId: string): Promise<ServiceResult<string> | null> {
  const hook = await prisma.graphHook.findUnique({ where: { id }, include: { site: true } });
  if (!hook) return null;
  if (hook.site.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Graph hook does not belong to this workspace");
  if (hook.isDeleted) return errorResult("GRAPH_HOOK_DELETED", "Graph hook has been deleted");
  return { data: hook.siteId };
}

export async function list(filter: ListGraphHooksFilter, scope: GraphScope): Promise<ListResult<unknown>> {
  const { name, enabled, eventNamespace, eventName, limit = 50, offset = 0 } = filter;
  const normalizedNamespace = normalizeFilterToken(eventNamespace);
  const normalizedName = normalizeFilterToken(eventName);
  if (normalizedNamespace === false || normalizedName === false) {
    return { data: [], total: 0, limit: Number(limit), offset: Number(offset) };
  }
  const where = {
    isDeleted: false,
    siteId: scope.siteId,
    site: { workspaceId: scope.workspaceId },
    ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(normalizedNamespace ? { eventNamespace: normalizedNamespace } : {}),
    ...(normalizedName ? { eventName: normalizedName } : {}),
  };
  const [hooks, total] = await Promise.all([
    prisma.graphHook.findMany({
      where,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.graphHook.count({ where }),
  ]);

  return { data: hooks, total, limit: Number(limit), offset: Number(offset) };
}

export function eventCatalog() {
  return { data: LIVESTORE_HOOK_EVENT_CATALOG };
}

function normalizeFilterToken(value: string | undefined): string | false | undefined {
  if (!value) return undefined;
  try {
    return normalizeLivestoreEventToken(value);
  } catch {
    return false;
  }
}

export async function activeHookIdsForProperties(propertyIds: readonly string[], scope: GraphScope): Promise<string[]> {
  const ids = new Set(propertyIds);
  if (ids.size === 0) return [];

  const hooks = await prisma.graphHook.findMany({
    where: {
      isDeleted: false,
      enabled: true,
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
    },
    select: { id: true, condition: true, eventContext: true },
  });

  return hooks
    .filter((hook) => {
      const condition = parseGraphHookCondition(hook.condition);
      if (!condition) return false;
      const context = parseGraphHookEventContext(hook.eventContext);
      if (!context) return false;
      return hookReferencedPropertyIds(condition, context).some((propertyId) => ids.has(propertyId));
    })
    .map((hook) => hook.id);
}
