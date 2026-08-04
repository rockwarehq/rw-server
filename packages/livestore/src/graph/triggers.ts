import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { createDefaultIntegrationRegistry, templateFieldNames, type IntegrationRegistry } from "@rw/integrations";
import {
  getLivestoreHookEventSchema,
  normalizeLivestoreEventToken,
  normalizeLivestoreEventVersion,
} from "../catalog/events.js";
import { parseGraphHookEventContext } from "../catalog/hook-conditions.js";
import { errorResult, type GraphScope } from "./types.js";

// Binds a LiveStore hook event to an integration action: hooks stay terminal
// (spec.md §4.8), this layer decides what an emitted event should do. Lives here
// rather than in services because it needs both hook definitions and the
// integration registry, and services cannot import livestore.

const registry: IntegrationRegistry = createDefaultIntegrationRegistry();

export interface CreateTriggerInput {
  name: string;
  enabled?: boolean;
  eventNamespace: string;
  eventName: string;
  eventVersion?: string;
  hookId?: string | null;
  integrationId: string;
  actionKey: string;
  actionVersion?: string;
  input: Record<string, unknown>;
}

export interface UpdateTriggerInput {
  name?: string;
  enabled?: boolean;
  eventNamespace?: string;
  eventName?: string;
  eventVersion?: string;
  hookId?: string | null;
  integrationId?: string;
  actionKey?: string;
  actionVersion?: string;
  input?: Record<string, unknown>;
}

const triggerSelect = {
  id: true,
  siteId: true,
  name: true,
  enabled: true,
  eventNamespace: true,
  eventName: true,
  eventVersion: true,
  hookId: true,
  integrationId: true,
  actionKey: true,
  actionVersion: true,
  input: true,
  isDeleted: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface ResolvedTrigger {
  eventNamespace: string;
  eventName: string;
  eventVersion: string;
  hookId: string | null;
  integrationId: string;
  actionKey: string;
  actionVersion: string;
  input: Record<string, unknown>;
}

function normalizeEvent(namespace: string, name: string, version: string) {
  try {
    return {
      data: {
        eventNamespace: normalizeLivestoreEventToken(namespace),
        eventName: normalizeLivestoreEventToken(name),
        eventVersion: normalizeLivestoreEventVersion(version),
      },
    };
  } catch (err) {
    return errorResult("INVALID_TRIGGER_EVENT", err instanceof Error ? err.message : "Trigger event is invalid");
  }
}

// Every field the template reads must actually be on the emitted payload, or the
// trigger fails at fire time with nobody watching.
async function assertTemplateFields(resolved: ResolvedTrigger, scope: GraphScope) {
  const fields = templateFieldNames(resolved.input);
  if (fields.length === 0) return null;

  const schema = getLivestoreHookEventSchema(resolved.eventNamespace, resolved.eventName, resolved.eventVersion);
  if (!schema) return errorResult("UNKNOWN_TRIGGER_EVENT", "Trigger event is not in the LiveStore catalog");

  const available = new Set(Object.keys(schema.contextFields));

  // The wire payload is {...hook.eventPayload, ...resolvedContext} for EVERY
  // event, so static payload keys count too; union across the hooks matched.
  const hooks = await prisma.graphHook.findMany({
    where: {
      isDeleted: false,
      siteId: scope.siteId,
      eventNamespace: resolved.eventNamespace,
      eventName: resolved.eventName,
      eventVersion: resolved.eventVersion,
      ...(resolved.hookId ? { id: resolved.hookId } : {}),
    },
    select: { eventPayload: true, eventContext: true },
  });

  for (const hook of hooks) {
    for (const field of Object.keys(parseGraphHookEventContext(hook.eventContext) ?? {})) available.add(field);
    if (hook.eventPayload && typeof hook.eventPayload === "object" && !Array.isArray(hook.eventPayload)) {
      for (const field of Object.keys(hook.eventPayload)) available.add(field);
    }
  }

  const missing = fields.filter((field) => !available.has(field));
  if (missing.length > 0) {
    return errorResult(
      "TRIGGER_FIELD_NOT_EMITTED",
      `No matching hook emits: ${missing.join(", ")}. Bind these as hook context fields first.`,
    );
  }
  return null;
}

async function assertReferences(resolved: ResolvedTrigger, scope: GraphScope) {
  const integration = await prisma.integration.findUnique({
    where: { id: resolved.integrationId },
    select: { id: true, type: true, siteId: true, isDeleted: true },
  });
  if (!integration || integration.isDeleted) return errorResult("INTEGRATION_NOT_FOUND", "Integration not found");
  if (integration.siteId !== scope.siteId) {
    return errorResult("SITE_MISMATCH", "Integration does not belong to this site");
  }

  const actionVersion = registry.getActionVersion(integration.type, resolved.actionKey, resolved.actionVersion);
  if (!actionVersion) {
    return errorResult(
      "UNKNOWN_INTEGRATION_ACTION",
      `Unknown action for ${integration.type}: ${resolved.actionKey}@${resolved.actionVersion}`,
    );
  }

  if (resolved.hookId) {
    const hook = await prisma.graphHook.findUnique({
      where: { id: resolved.hookId },
      select: { siteId: true, isDeleted: true },
    });
    if (!hook || hook.isDeleted) return errorResult("GRAPH_HOOK_NOT_FOUND", "Graph hook not found");
    if (hook.siteId !== scope.siteId) return errorResult("SITE_MISMATCH", "Graph hook does not belong to this site");
  }

  if (!getLivestoreHookEventSchema(resolved.eventNamespace, resolved.eventName, resolved.eventVersion)) {
    return errorResult(
      "UNKNOWN_TRIGGER_EVENT",
      `Unknown LiveStore event: ${resolved.eventNamespace}.${resolved.eventName}@${resolved.eventVersion}`,
    );
  }

  return assertTemplateFields(resolved, scope);
}

export async function create(input: CreateTriggerInput, scope: GraphScope) {
  const name = input.name.trim();
  if (!name) return errorResult("INVALID_NAME", "Trigger name is required");

  const event = normalizeEvent(input.eventNamespace, input.eventName, input.eventVersion ?? "1");
  if ("error" in event) return event;

  const resolved: ResolvedTrigger = {
    ...event.data,
    hookId: input.hookId ?? null,
    integrationId: input.integrationId,
    actionKey: input.actionKey,
    actionVersion: input.actionVersion ?? "1",
    input: input.input,
  };

  const referenceError = await assertReferences(resolved, scope);
  if (referenceError) return referenceError;

  const existing = await prisma.integrationTrigger.findUnique({
    where: { siteId_name: { siteId: scope.siteId, name } },
    select: { id: true, isDeleted: true },
  });
  if (existing && !existing.isDeleted) return errorResult("TRIGGER_NAME_EXISTS", "Trigger name already exists");

  const data = {
    siteId: scope.siteId,
    name,
    enabled: input.enabled ?? true,
    ...resolved,
    input: resolved.input as Prisma.InputJsonValue,
    isDeleted: false,
  };

  const row = existing
    ? await prisma.integrationTrigger.update({ where: { id: existing.id }, data, select: triggerSelect })
    : await prisma.integrationTrigger.create({ data, select: triggerSelect });

  return { data: row };
}

export async function update(id: string, input: UpdateTriggerInput, scope: GraphScope) {
  const current = await prisma.integrationTrigger.findUnique({
    where: { id },
    select: { ...triggerSelect, site: { select: { workspaceId: true } } },
  });
  if (!current || current.isDeleted) return errorResult("TRIGGER_NOT_FOUND", "Trigger not found");
  if (current.site.workspaceId !== scope.workspaceId) {
    return errorResult("WORKSPACE_MISMATCH", "Trigger does not belong to this workspace");
  }
  if (current.siteId !== scope.siteId) return errorResult("SITE_MISMATCH", "Trigger does not belong to this site");

  const event = normalizeEvent(
    input.eventNamespace ?? current.eventNamespace,
    input.eventName ?? current.eventName,
    input.eventVersion ?? current.eventVersion,
  );
  if ("error" in event) return event;

  const resolved: ResolvedTrigger = {
    ...event.data,
    hookId: input.hookId !== undefined ? input.hookId : current.hookId,
    integrationId: input.integrationId ?? current.integrationId,
    actionKey: input.actionKey ?? current.actionKey,
    actionVersion: input.actionVersion ?? current.actionVersion,
    input: (input.input ?? current.input) as Record<string, unknown>,
  };

  const referenceError = await assertReferences(resolved, scope);
  if (referenceError) return referenceError;

  const data: Prisma.IntegrationTriggerUpdateInput = {
    eventNamespace: resolved.eventNamespace,
    eventName: resolved.eventName,
    eventVersion: resolved.eventVersion,
    actionKey: resolved.actionKey,
    actionVersion: resolved.actionVersion,
    input: resolved.input as Prisma.InputJsonValue,
    integration: { connect: { id: resolved.integrationId } },
    hook: resolved.hookId ? { connect: { id: resolved.hookId } } : { disconnect: true },
  };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return errorResult("INVALID_NAME", "Trigger name is required");
    if (name !== current.name) {
      const conflict = await prisma.integrationTrigger.findUnique({
        where: { siteId_name: { siteId: scope.siteId, name } },
        select: { id: true },
      });
      if (conflict) return errorResult("TRIGGER_NAME_EXISTS", "Trigger name already exists");
    }
    data.name = name;
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;

  const row = await prisma.integrationTrigger.update({ where: { id }, data, select: triggerSelect });
  return { data: row };
}

export async function remove(id: string, scope: GraphScope) {
  const current = await prisma.integrationTrigger.findUnique({
    where: { id },
    select: { siteId: true, isDeleted: true, site: { select: { workspaceId: true } } },
  });
  if (!current || current.isDeleted) return errorResult("TRIGGER_NOT_FOUND", "Trigger not found");
  if (current.site.workspaceId !== scope.workspaceId) {
    return errorResult("WORKSPACE_MISMATCH", "Trigger does not belong to this workspace");
  }
  if (current.siteId !== scope.siteId) return errorResult("SITE_MISMATCH", "Trigger does not belong to this site");

  await prisma.integrationTrigger.update({ where: { id }, data: { isDeleted: true } });
  return { data: { success: true as const } };
}

export async function getById(id: string, scope: GraphScope) {
  const row = await prisma.integrationTrigger.findUnique({
    where: { id },
    select: { ...triggerSelect, site: { select: { workspaceId: true } } },
  });
  if (!row || row.isDeleted) return errorResult("TRIGGER_NOT_FOUND", "Trigger not found");
  if (row.site.workspaceId !== scope.workspaceId) {
    return errorResult("WORKSPACE_MISMATCH", "Trigger does not belong to this workspace");
  }
  if (row.siteId !== scope.siteId) return errorResult("SITE_MISMATCH", "Trigger does not belong to this site");

  const { site: _site, ...trigger } = row;
  return { data: trigger };
}

export interface ListTriggersFilter {
  integrationId?: string;
  hookId?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export async function list(filter: ListTriggersFilter, scope: GraphScope) {
  const { integrationId, hookId, enabled, limit = 50, offset = 0 } = filter;
  const where = {
    isDeleted: false,
    siteId: scope.siteId,
    site: { workspaceId: scope.workspaceId },
    ...(integrationId ? { integrationId } : {}),
    ...(hookId ? { hookId } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };

  const [data, total] = await Promise.all([
    prisma.integrationTrigger.findMany({
      where,
      select: triggerSelect,
      take: limit > 0 ? limit : undefined,
      skip: offset,
      orderBy: { name: "asc" },
    }),
    prisma.integrationTrigger.count({ where }),
  ]);

  return { data, total, limit, offset };
}

/** Enabled triggers matching an emitted event — the consumer's lookup. */
export async function matching(args: {
  siteId: string;
  eventNamespace: string;
  eventName: string;
  eventVersion: string;
  hookId: string;
}) {
  return prisma.integrationTrigger.findMany({
    where: {
      isDeleted: false,
      enabled: true,
      siteId: args.siteId,
      eventNamespace: args.eventNamespace,
      eventName: args.eventName,
      eventVersion: args.eventVersion,
      OR: [{ hookId: null }, { hookId: args.hookId }],
    },
    select: triggerSelect,
  });
}
