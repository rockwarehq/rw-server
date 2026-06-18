import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import type {
  CreateObjectModelFieldInput,
  CreateObjectModelInput,
  ListObjectModelsFilter,
  UpdateObjectModelFieldInput,
  UpdateObjectModelInput,
} from "./model.types.js";
import { errorResult, type EntityScope, type ListResult, normalizeEntityKey, type ServiceResult } from "./types.js";
import { validateAndNormalizeFieldConfig } from "./validation.js";

const modelInclude = {
  fields: {
    where: { isDeleted: false },
    orderBy: [{ sortOrder: "asc" as const }, { name: "asc" as const }],
  },
  _count: { select: { instances: true, graphNodes: true } },
};

function modelLabel(input: { label?: string; name?: string }): string {
  return (input.label ?? input.name ?? "").trim();
}

function normalizedKey(input: { key?: string; label?: string; name?: string }) {
  const key = normalizeEntityKey(input.key ?? input.label ?? input.name ?? "");
  return key || null;
}

async function getWritableModel(schemaId: string, scope: EntityScope) {
  const schema = await prisma.objectSchema.findUnique({ where: { id: schemaId } });
  if (!schema) return errorResult("SCHEMA_NOT_FOUND", "Model not found");
  if (schema.workspaceId !== scope.workspaceId || schema.siteId !== scope.siteId)
    return errorResult("SITE_MISMATCH", "Model does not belong to this site");
  if (schema.isDeleted) return errorResult("SCHEMA_DELETED", "Model has been deleted");
  if (schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "Only user-authored models can be edited through this API");
  return { data: schema };
}

async function validateRefModel(refSchemaId: string | null, scope: EntityScope) {
  if (!refSchemaId) return null;
  const refSchema = await prisma.objectSchema.findUnique({ where: { id: refSchemaId } });
  if (!refSchema || refSchema.isDeleted) return errorResult("REF_SCHEMA_NOT_FOUND", "Referenced model not found");
  if (refSchema.workspaceId !== scope.workspaceId || refSchema.siteId !== scope.siteId)
    return errorResult("REF_SCHEMA_SITE_MISMATCH", "Referenced model is outside this site");
  if (refSchema.source !== "DOCUMENT")
    return errorResult("REF_SCHEMA_SOURCE_INVALID", "OBJECT fields can only reference user-authored models");
  return null;
}

async function validateDisplayField(schemaId: string, displayFieldKey: string | null | undefined) {
  if (!displayFieldKey) return null;
  const field = await prisma.objectSchemaField.findFirst({ where: { schemaId, key: displayFieldKey, isDeleted: false } });
  return field ? null : errorResult("DISPLAY_FIELD_NOT_FOUND", "Display field was not found on this model");
}

export async function create(input: CreateObjectModelInput, scope: EntityScope): Promise<ServiceResult<unknown>> {
  const label = modelLabel(input);
  if (!label) return errorResult("INVALID_LABEL", "Model label is required");
  const key = normalizedKey(input);
  if (!key) return errorResult("INVALID_KEY", "Model key is required");

  const existing = await prisma.objectSchema.findUnique({
    where: { siteId_key: { siteId: scope.siteId, key } },
    include: modelInclude,
  });

  if (existing && !existing.isDeleted) return errorResult("SCHEMA_KEY_EXISTS", "Model key already exists");

  if (existing) {
    const schema = await prisma.objectSchema.update({
      where: { id: existing.id },
      data: { label, name: label, description: input.description ?? null, displayFieldKey: input.displayFieldKey ?? null, isDeleted: false },
      include: modelInclude,
    });
    return { data: schema };
  }

  const schema = await prisma.objectSchema.create({
    data: {
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      key,
      label,
      name: label,
      description: input.description ?? null,
      displayFieldKey: input.displayFieldKey ?? null,
    },
    include: modelInclude,
  });
  return { data: schema };
}

export async function list(filter: ListObjectModelsFilter, scope: EntityScope): Promise<ListResult<unknown>> {
  const { key, label, limit = 50, offset = 0 } = filter;
  const where = {
    workspaceId: scope.workspaceId,
    siteId: scope.siteId,
    source: "DOCUMENT" as const,
    isDeleted: false,
    ...(key ? { key } : {}),
    ...(label ? { label: { contains: label, mode: "insensitive" as const } } : {}),
  };

  const [schemas, total] = await Promise.all([
    prisma.objectSchema.findMany({
      where,
      include: modelInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { label: "asc" },
    }),
    prisma.objectSchema.count({ where }),
  ]);

  return { data: schemas, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string, scope: EntityScope): Promise<ServiceResult<unknown> | null> {
  const schema = await prisma.objectSchema.findUnique({ where: { id }, include: modelInclude });
  if (!schema) return null;
  if (schema.workspaceId !== scope.workspaceId || schema.siteId !== scope.siteId)
    return errorResult("SITE_MISMATCH", "Model does not belong to this site");
  if (schema.isDeleted) return errorResult("SCHEMA_DELETED", "Model has been deleted");
  return { data: schema };
}

export async function update(
  id: string,
  input: UpdateObjectModelInput,
  scope: EntityScope,
): Promise<ServiceResult<unknown>> {
  const current = await prisma.objectSchema.findUnique({ where: { id } });
  if (!current) return errorResult("SCHEMA_NOT_FOUND", "Model not found");
  if (current.workspaceId !== scope.workspaceId || current.siteId !== scope.siteId)
    return errorResult("SITE_MISMATCH", "Model does not belong to this site");
  if (current.isDeleted) return errorResult("SCHEMA_DELETED", "Model has been deleted");
  if (current.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "Only user-authored models can be updated through this API");

  const updateData: Record<string, unknown> = {};
  if (input.key !== undefined) {
    const key = normalizedKey(input);
    if (!key) return errorResult("INVALID_KEY", "Model key is required");
    if (key !== current.key) {
      const conflict = await prisma.objectSchema.findUnique({ where: { siteId_key: { siteId: scope.siteId, key } } });
      if (conflict) return errorResult("SCHEMA_KEY_EXISTS", "Model key already exists");
    }
    updateData.key = key;
  }
  if (input.label !== undefined) {
    const label = modelLabel(input);
    if (!label) return errorResult("INVALID_LABEL", "Model label is required");
    updateData.label = label;
    updateData.name = label;
  }
  if (input.description !== undefined) updateData.description = input.description;
  if (input.displayFieldKey !== undefined) {
    const displayFieldError = await validateDisplayField(id, input.displayFieldKey);
    if (displayFieldError) return displayFieldError;
    updateData.displayFieldKey = input.displayFieldKey;
  }

  const schema = await prisma.objectSchema.update({ where: { id }, data: updateData, include: modelInclude });
  return { data: schema };
}

export async function remove(id: string, scope: EntityScope): Promise<ServiceResult<{ success: true }>> {
  const current = await prisma.objectSchema.findUnique({ where: { id } });
  if (!current) return errorResult("SCHEMA_NOT_FOUND", "Model not found");
  if (current.workspaceId !== scope.workspaceId || current.siteId !== scope.siteId)
    return errorResult("SITE_MISMATCH", "Model does not belong to this site");
  if (current.isDeleted) return { data: { success: true } };
  if (current.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "Only user-authored models can be deleted through this API");

  await prisma.$transaction([
    prisma.objectSchema.update({ where: { id }, data: { isDeleted: true } }),
    prisma.objectSchemaField.updateMany({ where: { schemaId: id }, data: { isDeleted: true } }),
    prisma.objectInstance.updateMany({ where: { schemaId: id }, data: { isDeleted: true } }),
  ]);

  return { data: { success: true } };
}

export async function createField(
  input: CreateObjectModelFieldInput,
  scope: EntityScope,
): Promise<ServiceResult<unknown>> {
  const schemaResult = await getWritableModel(input.schemaId, scope);
  if ("error" in schemaResult) return schemaResult;

  const label = modelLabel(input);
  if (!label) return errorResult("INVALID_LABEL", "Field label is required");
  const key = normalizedKey(input);
  if (!key) return errorResult("INVALID_KEY", "Field key is required");

  const normalizedResult = validateAndNormalizeFieldConfig({
    type: input.type,
    refSchemaId: input.refSchemaId,
    config: input.config,
  });
  if (!normalizedResult.normalized) return errorResult("INVALID_FIELD_CONFIG", normalizedResult.errors.join("; "));

  const refError = await validateRefModel(normalizedResult.normalized.refSchemaId, scope);
  if (refError) return refError;

  const existing = await prisma.objectSchemaField.findUnique({
    where: { schemaId_key: { schemaId: input.schemaId, key } },
  });
  if (existing && !existing.isDeleted)
    return errorResult("FIELD_NAME_EXISTS", "Field name already exists on this model");

  const data = {
    name: key,
    key,
    label,
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

export async function updateField(
  id: string,
  input: UpdateObjectModelFieldInput,
  scope: EntityScope,
): Promise<ServiceResult<unknown>> {
  const current = await prisma.objectSchemaField.findUnique({ where: { id }, include: { schema: true } });
  if (!current) return errorResult("FIELD_NOT_FOUND", "Field not found");
  if (current.schema.workspaceId !== scope.workspaceId || current.schema.siteId !== scope.siteId)
    return errorResult("SITE_MISMATCH", "Field does not belong to this site");
  if (current.schema.isDeleted) return errorResult("SCHEMA_DELETED", "Model has been deleted");
  if (current.isDeleted) return errorResult("FIELD_DELETED", "Field has been deleted");
  if (current.schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "Only user-authored models can be edited through this API");

  const nextType = input.type ?? current.type;
  const normalizedResult = validateAndNormalizeFieldConfig({
    type: nextType,
    refSchemaId: input.refSchemaId !== undefined ? input.refSchemaId : current.refSchemaId,
    config: input.config !== undefined ? input.config : (current.config as Record<string, unknown> | null),
  });
  if (!normalizedResult.normalized) return errorResult("INVALID_FIELD_CONFIG", normalizedResult.errors.join("; "));

  const refError = await validateRefModel(normalizedResult.normalized.refSchemaId, scope);
  if (refError) return refError;

  const updateData: Record<string, unknown> = {
    type: nextType,
    refSchemaId: normalizedResult.normalized.refSchemaId,
    config: normalizedResult.normalized.config,
  };
  if (input.key !== undefined) {
    const key = normalizedKey(input);
    if (!key) return errorResult("INVALID_KEY", "Field key is required");
    if (key !== current.key) {
      const conflict = await prisma.objectSchemaField.findUnique({
        where: { schemaId_key: { schemaId: current.schemaId, key } },
      });
      if (conflict) return errorResult("FIELD_NAME_EXISTS", "Field name already exists on this model");
    }
    updateData.key = key;
    updateData.name = key;
  }
  if (input.label !== undefined) {
    const label = modelLabel(input);
    if (!label) return errorResult("INVALID_LABEL", "Field label is required");
    updateData.label = label;
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

export async function reorderFields(
  schemaId: string,
  fieldIds: readonly string[],
  scope: EntityScope,
): Promise<ServiceResult<{ success: true }>> {
  const schemaResult = await getWritableModel(schemaId, scope);
  if ("error" in schemaResult) return schemaResult;

  const uniqueIds = [...new Set(fieldIds)];
  if (uniqueIds.length !== fieldIds.length) return errorResult("DUPLICATE_FIELD_IDS", "Field ids must be unique");

  const fields = await prisma.objectSchemaField.findMany({
    where: { id: { in: uniqueIds }, schemaId, isDeleted: false },
  });
  if (fields.length !== uniqueIds.length)
    return errorResult("FIELD_NOT_FOUND", "One or more fields were not found on this model");

  await prisma.$transaction([
    ...uniqueIds.map((id, index) => prisma.objectSchemaField.update({ where: { id }, data: { sortOrder: index } })),
    prisma.objectSchema.update({ where: { id: schemaId }, data: { version: { increment: 1 } } }),
  ]);

  return { data: { success: true } };
}

export async function removeField(id: string, scope: EntityScope): Promise<ServiceResult<{ success: true }>> {
  const current = await prisma.objectSchemaField.findUnique({ where: { id }, include: { schema: true } });
  if (!current) return errorResult("FIELD_NOT_FOUND", "Field not found");
  if (current.schema.workspaceId !== scope.workspaceId || current.schema.siteId !== scope.siteId)
    return errorResult("SITE_MISMATCH", "Field does not belong to this site");
  if (current.isDeleted) return { data: { success: true } };
  if (current.schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_READ_ONLY", "Only user-authored models can be edited through this API");

  await prisma.$transaction([
    prisma.objectSchemaField.update({ where: { id }, data: { isDeleted: true } }),
    prisma.objectSchema.update({ where: { id: current.schemaId }, data: { version: { increment: 1 } } }),
  ]);

  return { data: { success: true } };
}
