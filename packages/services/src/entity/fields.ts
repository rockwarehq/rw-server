import prisma from "@rw/db";
import type { ObjectFieldType, Prisma } from "@rw/db";

import { errorResult, type ServiceResult } from "./types.js";
import { validateAndNormalizeFieldConfig } from "./validation.js";

export interface CreateObjectSchemaFieldInput {
  schemaId: string;
  name: string;
  description?: string;
  type: ObjectFieldType;
  refSchemaId?: string | null;
  isList?: boolean;
  required?: boolean;
  config?: Record<string, unknown> | null;
  sortOrder?: number;
}

export interface UpdateObjectSchemaFieldInput {
  name?: string;
  description?: string | null;
  type?: ObjectFieldType;
  refSchemaId?: string | null;
  isList?: boolean;
  required?: boolean;
  config?: Record<string, unknown> | null;
  sortOrder?: number;
}

async function getWritableSchema(schemaId: string, workspaceId: string) {
  const schema = await prisma.objectSchema.findUnique({ where: { id: schemaId } });
  if (!schema) return errorResult("SCHEMA_NOT_FOUND", "Schema not found");
  if (schema.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Schema does not belong to this workspace");
  if (schema.isDeleted) return errorResult("SCHEMA_DELETED", "Schema has been deleted");
  if (schema.isSystem || schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "System and record schemas cannot be edited through this API");
  return { data: schema };
}

async function validateRefSchema(refSchemaId: string | null, workspaceId: string) {
  if (!refSchemaId) return null;
  const refSchema = await prisma.objectSchema.findUnique({ where: { id: refSchemaId } });
  if (!refSchema || refSchema.isDeleted) return errorResult("REF_SCHEMA_NOT_FOUND", "Referenced schema not found");
  if (refSchema.workspaceId !== workspaceId)
    return errorResult("REF_SCHEMA_WORKSPACE_MISMATCH", "Referenced schema is outside this workspace");
  if (refSchema.source !== "DOCUMENT")
    return errorResult("REF_SCHEMA_SOURCE_INVALID", "OBJECT fields can only reference DOCUMENT schemas");
  return null;
}

export async function create(
  input: CreateObjectSchemaFieldInput,
  workspaceId: string,
): Promise<ServiceResult<unknown>> {
  const schemaResult = await getWritableSchema(input.schemaId, workspaceId);
  if ("error" in schemaResult) return schemaResult;

  const name = input.name.trim();
  if (!name) return errorResult("INVALID_NAME", "Field name is required");

  const normalizedResult = validateAndNormalizeFieldConfig({
    type: input.type,
    refSchemaId: input.refSchemaId,
    config: input.config,
  });
  if (!normalizedResult.normalized) return errorResult("INVALID_FIELD_CONFIG", normalizedResult.errors.join("; "));

  const refError = await validateRefSchema(normalizedResult.normalized.refSchemaId, workspaceId);
  if (refError) return refError;

  const existing = await prisma.objectSchemaField.findUnique({
    where: { schemaId_name: { schemaId: input.schemaId, name } },
  });
  if (existing && !existing.isDeleted)
    return errorResult("FIELD_NAME_EXISTS", "Field name already exists on this schema");

  const data = {
    name,
    description: input.description ?? null,
    type: input.type,
    refSchemaId: normalizedResult.normalized.refSchemaId,
    isList: input.isList ?? false,
    required: input.required ?? false,
    config: normalizedResult.normalized.config as Prisma.InputJsonValue | null,
    sortOrder: input.sortOrder ?? 0,
    isDeleted: false,
  };

  const field = await prisma.$transaction(async (tx) => {
    const next = existing
      ? await tx.objectSchemaField.update({ where: { id: existing.id }, data })
      : await tx.objectSchemaField.create({ data: { ...data, schemaId: input.schemaId } });
    await tx.objectSchema.update({ where: { id: input.schemaId }, data: { version: { increment: 1 } } });
    return next;
  });

  return { data: field };
}

export async function update(
  id: string,
  input: UpdateObjectSchemaFieldInput,
  workspaceId: string,
): Promise<ServiceResult<unknown>> {
  const current = await prisma.objectSchemaField.findUnique({ where: { id }, include: { schema: true } });
  if (!current) return errorResult("FIELD_NOT_FOUND", "Field not found");
  if (current.schema.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Field does not belong to this workspace");
  if (current.schema.isDeleted) return errorResult("SCHEMA_DELETED", "Schema has been deleted");
  if (current.isDeleted) return errorResult("FIELD_DELETED", "Field has been deleted");
  if (current.schema.isSystem || current.schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "System and record schemas cannot be edited through this API");

  const nextType = input.type ?? current.type;
  const normalizedResult = validateAndNormalizeFieldConfig({
    type: nextType,
    refSchemaId: input.refSchemaId !== undefined ? input.refSchemaId : current.refSchemaId,
    config: input.config !== undefined ? input.config : (current.config as Record<string, unknown> | null),
  });
  if (!normalizedResult.normalized) return errorResult("INVALID_FIELD_CONFIG", normalizedResult.errors.join("; "));

  const refError = await validateRefSchema(normalizedResult.normalized.refSchemaId, workspaceId);
  if (refError) return refError;

  const updateData: Record<string, unknown> = {
    type: nextType,
    refSchemaId: normalizedResult.normalized.refSchemaId,
    config: normalizedResult.normalized.config,
  };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return errorResult("INVALID_NAME", "Field name is required");
    if (name !== current.name) {
      const conflict = await prisma.objectSchemaField.findUnique({
        where: { schemaId_name: { schemaId: current.schemaId, name } },
      });
      if (conflict) return errorResult("FIELD_NAME_EXISTS", "Field name already exists on this schema");
    }
    updateData.name = name;
  }
  if (input.description !== undefined) updateData.description = input.description;
  if (input.isList !== undefined) updateData.isList = input.isList;
  if (input.required !== undefined) updateData.required = input.required;
  if (input.sortOrder !== undefined) updateData.sortOrder = input.sortOrder;

  const field = await prisma.$transaction(async (tx) => {
    const next = await tx.objectSchemaField.update({ where: { id }, data: updateData });
    await tx.objectSchema.update({ where: { id: current.schemaId }, data: { version: { increment: 1 } } });
    return next;
  });

  return { data: field };
}

export async function reorder(
  schemaId: string,
  fieldIds: readonly string[],
  workspaceId: string,
): Promise<ServiceResult<{ success: true }>> {
  const schemaResult = await getWritableSchema(schemaId, workspaceId);
  if ("error" in schemaResult) return schemaResult;

  const uniqueIds = [...new Set(fieldIds)];
  if (uniqueIds.length !== fieldIds.length) return errorResult("DUPLICATE_FIELD_IDS", "Field ids must be unique");

  const fields = await prisma.objectSchemaField.findMany({
    where: { id: { in: uniqueIds }, schemaId, isDeleted: false },
  });
  if (fields.length !== uniqueIds.length)
    return errorResult("FIELD_NOT_FOUND", "One or more fields were not found on this schema");

  await prisma.$transaction([
    ...uniqueIds.map((id, index) => prisma.objectSchemaField.update({ where: { id }, data: { sortOrder: index } })),
    prisma.objectSchema.update({ where: { id: schemaId }, data: { version: { increment: 1 } } }),
  ]);

  return { data: { success: true } };
}

export async function remove(id: string, workspaceId: string): Promise<ServiceResult<{ success: true }>> {
  const current = await prisma.objectSchemaField.findUnique({ where: { id }, include: { schema: true } });
  if (!current) return errorResult("FIELD_NOT_FOUND", "Field not found");
  if (current.schema.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Field does not belong to this workspace");
  if (current.isDeleted) return { data: { success: true } };
  if (current.schema.isSystem || current.schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "System and record schemas cannot be edited through this API");

  await prisma.$transaction([
    prisma.objectSchemaField.update({ where: { id }, data: { isDeleted: true } }),
    prisma.objectSchema.update({ where: { id: current.schemaId }, data: { version: { increment: 1 } } }),
  ]);

  return { data: { success: true } };
}
