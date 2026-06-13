import prisma from "@rw/db";

import { errorResult, type ListResult, type ServiceResult } from "./types.js";

export interface CreateObjectSchemaInput {
  name: string;
  description?: string;
}

export interface UpdateObjectSchemaInput {
  name?: string;
  description?: string | null;
}

export interface ListObjectSchemasFilter {
  name?: string;
  limit?: number;
  offset?: number;
}

const schemaInclude = {
  fields: {
    where: { isDeleted: false },
    orderBy: [{ sortOrder: "asc" as const }, { name: "asc" as const }],
  },
  _count: { select: { instances: true, graphNodes: true } },
};

export async function create(input: CreateObjectSchemaInput, workspaceId: string): Promise<ServiceResult<unknown>> {
  const name = input.name.trim();
  if (!name) return errorResult("INVALID_NAME", "Schema name is required");

  const existing = await prisma.objectSchema.findUnique({
    where: { workspaceId_name: { workspaceId, name } },
    include: schemaInclude,
  });

  if (existing && !existing.isDeleted) return errorResult("SCHEMA_NAME_EXISTS", "Schema name already exists");

  if (existing) {
    const schema = await prisma.objectSchema.update({
      where: { id: existing.id },
      data: { description: input.description ?? null, isDeleted: false },
      include: schemaInclude,
    });
    return { data: schema };
  }

  const schema = await prisma.objectSchema.create({
    data: { workspaceId, name, description: input.description ?? null },
    include: schemaInclude,
  });
  return { data: schema };
}

export async function list(filter: ListObjectSchemasFilter, workspaceId: string): Promise<ListResult<unknown>> {
  const { name, limit = 50, offset = 0 } = filter;
  const where = {
    workspaceId,
    source: "DOCUMENT" as const,
    isDeleted: false,
    ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
  };

  const [schemas, total] = await Promise.all([
    prisma.objectSchema.findMany({
      where,
      include: schemaInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.objectSchema.count({ where }),
  ]);

  return { data: schemas, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string, workspaceId: string): Promise<ServiceResult<unknown> | null> {
  const schema = await prisma.objectSchema.findUnique({ where: { id }, include: schemaInclude });
  if (!schema) return null;
  if (schema.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Schema does not belong to this workspace");
  if (schema.isDeleted) return errorResult("SCHEMA_DELETED", "Schema has been deleted");
  return { data: schema };
}

export async function update(
  id: string,
  input: UpdateObjectSchemaInput,
  workspaceId: string,
): Promise<ServiceResult<unknown>> {
  const current = await prisma.objectSchema.findUnique({ where: { id } });
  if (!current) return errorResult("SCHEMA_NOT_FOUND", "Schema not found");
  if (current.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Schema does not belong to this workspace");
  if (current.isDeleted) return errorResult("SCHEMA_DELETED", "Schema has been deleted");
  if (current.isSystem || current.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "System and record schemas cannot be updated through this API");

  const updateData: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return errorResult("INVALID_NAME", "Schema name is required");
    if (name !== current.name) {
      const conflict = await prisma.objectSchema.findUnique({ where: { workspaceId_name: { workspaceId, name } } });
      if (conflict) return errorResult("SCHEMA_NAME_EXISTS", "Schema name already exists");
    }
    updateData.name = name;
  }
  if (input.description !== undefined) updateData.description = input.description;

  const schema = await prisma.objectSchema.update({ where: { id }, data: updateData, include: schemaInclude });
  return { data: schema };
}

export async function remove(id: string, workspaceId: string): Promise<ServiceResult<{ success: true }>> {
  const current = await prisma.objectSchema.findUnique({ where: { id } });
  if (!current) return errorResult("SCHEMA_NOT_FOUND", "Schema not found");
  if (current.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Schema does not belong to this workspace");
  if (current.isDeleted) return { data: { success: true } };
  if (current.isSystem || current.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "System and record schemas cannot be deleted through this API");

  await prisma.$transaction([
    prisma.objectSchema.update({ where: { id }, data: { isDeleted: true } }),
    prisma.objectSchemaField.updateMany({ where: { schemaId: id }, data: { isDeleted: true } }),
    prisma.objectInstance.updateMany({ where: { schemaId: id }, data: { isDeleted: true } }),
  ]);

  return { data: { success: true } };
}
