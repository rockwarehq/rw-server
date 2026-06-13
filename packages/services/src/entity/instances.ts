import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import { errorResult, type ListResult, type ServiceResult } from "./types.js";
import { asValueRecord, validateInstanceValues } from "./validation.js";

export interface CreateObjectInstanceInput {
  schemaId: string;
  name: string;
  values?: Record<string, unknown>;
}

export interface UpdateObjectInstanceInput {
  name?: string;
  values?: Record<string, unknown>;
}

export interface ListObjectInstancesFilter {
  schemaId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

const instanceInclude = {
  schema: { select: { id: true, name: true, source: true, workspaceId: true, version: true } },
};

async function getSchemaWithFields(schemaId: string, workspaceId: string) {
  const schema = await prisma.objectSchema.findUnique({
    where: { id: schemaId },
    include: { fields: { where: { isDeleted: false }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
  });
  if (!schema) return errorResult("SCHEMA_NOT_FOUND", "Schema not found");
  if (schema.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Schema does not belong to this workspace");
  if (schema.isDeleted) return errorResult("SCHEMA_DELETED", "Schema has been deleted");
  if (schema.source !== "DOCUMENT") return errorResult("SCHEMA_SOURCE_INVALID", "Only DOCUMENT schemas can create documents");
  return { data: schema };
}

async function validateObjectRefs(refs: readonly string[], workspaceId: string) {
  if (refs.length === 0) return null;
  const count = await prisma.objectInstance.count({
    where: { id: { in: [...refs] }, isDeleted: false, schema: { workspaceId, source: "DOCUMENT", isDeleted: false } },
  });
  return count === refs.length
    ? null
    : errorResult("OBJECT_REF_NOT_FOUND", "One or more object references were not found");
}

export async function create(input: CreateObjectInstanceInput, workspaceId: string): Promise<ServiceResult<unknown>> {
  const schemaResult = await getSchemaWithFields(input.schemaId, workspaceId);
  if ("error" in schemaResult) return schemaResult;

  const name = input.name.trim();
  if (!name) return errorResult("INVALID_NAME", "Instance name is required");

  const validation = validateInstanceValues(schemaResult.data.fields, input.values ?? {});
  if (validation.errors.length > 0) return errorResult("INVALID_VALUES", validation.errors.join("; "));
  const refError = await validateObjectRefs(validation.objectInstanceRefs, workspaceId);
  if (refError) return refError;

  const instance = await prisma.objectInstance.create({
    data: {
      schemaId: input.schemaId,
      name,
      values: validation.values as Prisma.InputJsonValue,
    },
    include: instanceInclude,
  });
  return { data: instance };
}

export async function list(filter: ListObjectInstancesFilter, workspaceId: string): Promise<ListResult<unknown>> {
  const { schemaId, name, limit = 50, offset = 0 } = filter;
  const where = {
    isDeleted: false,
    schema: { workspaceId, source: "DOCUMENT" as const, isDeleted: false },
    ...(schemaId ? { schemaId } : {}),
    ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
  };

  const [instances, total] = await Promise.all([
    prisma.objectInstance.findMany({
      where,
      include: instanceInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.objectInstance.count({ where }),
  ]);

  return { data: instances, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string, workspaceId: string): Promise<ServiceResult<unknown> | null> {
  const instance = await prisma.objectInstance.findUnique({ where: { id }, include: instanceInclude });
  if (!instance) return null;
  if (instance.schema.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Instance does not belong to this workspace");
  if (instance.schema.source !== "DOCUMENT") return errorResult("SCHEMA_SOURCE_INVALID", "Only DOCUMENT schemas have documents");
  if (instance.isDeleted) return errorResult("INSTANCE_DELETED", "Instance has been deleted");
  return { data: instance };
}

export async function update(
  id: string,
  input: UpdateObjectInstanceInput,
  workspaceId: string,
): Promise<ServiceResult<unknown>> {
  const current = await prisma.objectInstance.findUnique({
    where: { id },
    include: { schema: { include: { fields: { where: { isDeleted: false } } } } },
  });
  if (!current) return errorResult("INSTANCE_NOT_FOUND", "Instance not found");
  if (current.schema.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Instance does not belong to this workspace");
  if (current.schema.source !== "DOCUMENT") return errorResult("SCHEMA_SOURCE_INVALID", "Only DOCUMENT schemas have documents");
  if (current.schema.isDeleted) return errorResult("SCHEMA_DELETED", "Schema has been deleted");
  if (current.isDeleted) return errorResult("INSTANCE_DELETED", "Instance has been deleted");

  const updateData: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return errorResult("INVALID_NAME", "Instance name is required");
    updateData.name = name;
  }

  if (input.values !== undefined) {
    const mergedValues = { ...asValueRecord(current.values), ...input.values };
    const validation = validateInstanceValues(current.schema.fields, mergedValues);
    if (validation.errors.length > 0) return errorResult("INVALID_VALUES", validation.errors.join("; "));
    const refError = await validateObjectRefs(validation.objectInstanceRefs, workspaceId);
    if (refError) return refError;
    updateData.values = validation.values;
  }

  const instance = await prisma.objectInstance.update({ where: { id }, data: updateData, include: instanceInclude });
  return { data: instance };
}

export async function remove(id: string, workspaceId: string): Promise<ServiceResult<{ success: true }>> {
  const current = await prisma.objectInstance.findUnique({ where: { id }, include: { schema: true } });
  if (!current) return errorResult("INSTANCE_NOT_FOUND", "Instance not found");
  if (current.schema.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Instance does not belong to this workspace");
  if (current.schema.source !== "DOCUMENT") return errorResult("SCHEMA_SOURCE_INVALID", "Only DOCUMENT schemas have documents");
  if (current.isDeleted) return { data: { success: true } };

  await prisma.objectInstance.update({ where: { id }, data: { isDeleted: true } });
  return { data: { success: true } };
}
