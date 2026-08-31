import prisma, { Prisma } from "@rw/db";
import type { CallDefinition, CallSeverity } from "@rw/db";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";

type ServiceError = { error: string; code: string };

const DUPLICATE_NAME: ServiceError = {
  error: "A call definition with this name already exists for this site",
  code: "DUPLICATE_NAME",
};

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export interface CreateCallDefinitionInput {
  siteId: string;
  name: string;
  description?: string;
  severity?: CallSeverity;
  requireOpenMessage?: boolean;
}

export interface UpdateCallDefinitionInput {
  name?: string;
  description?: string | null;
  severity?: CallSeverity;
  requireOpenMessage?: boolean;
}

export interface ListCallDefinitionsFilter {
  siteId?: string;
  includeArchived?: boolean;
  name?: string;
  limit?: number;
  offset?: number;
}

export async function createDefinition(
  input: CreateCallDefinitionInput,
): Promise<ServiceError | { data: CallDefinition }> {
  const { siteId, name, description, severity, requireOpenMessage } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });
  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Names are unique per site, archived rows included (archive/unarchive
  // name semantics are still to be decided).
  const existing = await prisma.callDefinition.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { id: true },
  });
  if (existing) return DUPLICATE_NAME;

  try {
    const definition = await prisma.callDefinition.create({
      data: {
        siteId,
        name,
        description: description ?? null,
        severity: severity ?? "INFORMATION",
        requireOpenMessage: requireOpenMessage ?? false,
      },
    });

    publishEntityEvent({
      action: "created",
      entityKey: SYSTEM_ENTITY_KEYS.CallDefinition,
      entityId: definition.id,
      siteId: definition.siteId,
      workspaceId: site.workspaceId,
    });

    return { data: definition };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

export async function listDefinitions(filter: ListCallDefinitionsFilter = {}) {
  const { siteId, includeArchived, name, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = {};
  if (!includeArchived) where.archivedAt = null;
  if (siteId) where.siteId = siteId;
  if (name) where.name = { contains: name, mode: "insensitive" };

  const [definitions, total] = await Promise.all([
    prisma.callDefinition.findMany({
      where,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.callDefinition.count({ where }),
  ]);

  return { data: definitions, total, limit: Number(limit), offset: Number(offset) };
}

export async function getDefinitionById(id: string) {
  const definition = await prisma.callDefinition.findUnique({ where: { id } });
  if (!definition || definition.archivedAt) {
    return null;
  }
  return { data: definition };
}

export async function updateDefinition(
  id: string,
  input: UpdateCallDefinitionInput,
): Promise<ServiceError | { data: CallDefinition }> {
  const current = await prisma.callDefinition.findUnique({
    where: { id },
    select: { id: true, siteId: true, archivedAt: true, site: { select: { workspaceId: true } } },
  });
  if (!current || current.archivedAt) {
    return { error: "Call definition not found", code: "DEFINITION_NOT_FOUND" };
  }

  if (input.name !== undefined) {
    const existing = await prisma.callDefinition.findUnique({
      where: { siteId_name: { siteId: current.siteId, name: input.name } },
      select: { id: true },
    });
    if (existing && existing.id !== id) return DUPLICATE_NAME;
  }

  const updateData: Record<string, unknown> = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.severity !== undefined) updateData.severity = input.severity;
  if (input.requireOpenMessage !== undefined) updateData.requireOpenMessage = input.requireOpenMessage;

  try {
    const definition = await prisma.callDefinition.update({
      where: { id },
      data: updateData,
    });

    publishEntityEvent({
      action: "updated",
      entityKey: SYSTEM_ENTITY_KEYS.CallDefinition,
      entityId: definition.id,
      siteId: definition.siteId,
      workspaceId: current.site.workspaceId,
      changedFields: Object.keys(updateData),
    });

    return { data: definition };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

/** Archive (soft): open calls against the definition stay open and closable. */
export async function archiveDefinition(id: string): Promise<ServiceError | { data: { success: boolean } }> {
  const definition = await prisma.callDefinition.findUnique({
    where: { id },
    select: { id: true, siteId: true, archivedAt: true, site: { select: { workspaceId: true } } },
  });
  if (!definition || definition.archivedAt) {
    return { error: "Call definition not found", code: "DEFINITION_NOT_FOUND" };
  }

  await prisma.callDefinition.update({
    where: { id },
    data: { archivedAt: new Date() },
  });

  publishEntityEvent({
    action: "deleted",
    entityKey: SYSTEM_ENTITY_KEYS.CallDefinition,
    entityId: definition.id,
    siteId: definition.siteId,
    workspaceId: definition.site.workspaceId,
  });

  return { data: { success: true } };
}
