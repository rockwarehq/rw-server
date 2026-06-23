import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import {
  LIVESTORE_GRAPH_TYPE_NAMESPACES,
  graphTypeRef,
  normalizeGraphTypeValueType,
  normalizeGraphTypeToken,
  parseGraphTypeRef,
  type GraphTypeValueType,
  type LivestoreGraphTypeFieldSchema,
  type LivestoreGraphTypeNamespaceSchema,
  type LivestoreGraphTypeSchema,
} from "@rw/runtime/livestore-graph-types";

import { getGraphSiteForWorkspace } from "./scope.js";
import { errorResult, type GraphScope, type ListResult, type ServiceResult } from "./types.js";

export interface GraphNodeTypeFieldInput {
  key: string;
  label: string;
  description?: string | null;
  valueType: GraphTypeValueType;
  required?: boolean;
  resolverType: string;
  resolver: Record<string, unknown>;
  sampleRateMs?: number | null;
  sortOrder?: number;
}

export interface CreateGraphNodeTypeInput {
  key: string;
  label: string;
  description?: string | null;
  fields?: GraphNodeTypeFieldInput[];
}

export interface UpdateGraphNodeTypeInput {
  key?: string;
  label?: string;
  description?: string | null;
}

export interface CreateGraphNodeTypeFieldInput extends GraphNodeTypeFieldInput {
  typeId: string;
}

export interface UpdateGraphNodeTypeFieldInput {
  key?: string;
  label?: string;
  description?: string | null;
  valueType?: GraphTypeValueType;
  required?: boolean;
  resolverType?: string;
  resolver?: Record<string, unknown>;
  sampleRateMs?: number | null;
  sortOrder?: number;
}

export interface ListGraphNodeTypesFilter {
  key?: string;
  label?: string;
  limit?: number;
  offset?: number;
}

export interface ResolvedGraphType {
  typeRef: string;
  source: "integration" | "site";
  namespace: string | null;
  key: string;
  label: string;
  description?: string | null;
  integration?: string;
  fields: LivestoreGraphTypeFieldSchema[];
}

interface NormalizedGraphNodeTypeField {
  key: string;
  label: string;
  description: string | null;
  valueType: GraphTypeValueType;
  required: boolean;
  resolverType: string;
  resolver: Record<string, unknown>;
  sampleRateMs: number | null;
  sortOrder: number;
}

const siteTypeInclude = {
  fields: {
    where: { isDeleted: false },
    orderBy: [{ sortOrder: "asc" as const }, { key: "asc" as const }],
  },
};

function normalizeLabel(value: string): string | null {
  const label = value.trim();
  return label ? label : null;
}

function normalizeResolverType(value: string): string | null {
  const resolverType = value.trim();
  return resolverType ? resolverType : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFieldInput(input: GraphNodeTypeFieldInput) {
  let key: string;
  try {
    key = normalizeGraphTypeToken(input.key);
  } catch (err) {
    return errorResult("INVALID_KEY", err instanceof Error ? err.message : "Graph type field key is invalid");
  }
  const label = normalizeLabel(input.label);
  if (!label) return errorResult("INVALID_LABEL", "Graph type field label is required");
  const resolverType = normalizeResolverType(input.resolverType);
  if (!resolverType) return errorResult("INVALID_RESOLVER_TYPE", "Graph type field resolverType is required");
  if (!isRecord(input.resolver)) return errorResult("INVALID_RESOLVER", "Graph type field resolver must be an object");
  let valueType: GraphTypeValueType;
  try {
    valueType = normalizeGraphTypeValueType(input.valueType);
  } catch (err) {
    return errorResult(
      "INVALID_VALUE_TYPE",
      err instanceof Error ? err.message : "Graph type field valueType is invalid",
    );
  }
  return {
    data: {
      key,
      label,
      description: input.description ?? null,
      valueType,
      required: input.required ?? false,
      resolverType,
      resolver: input.resolver,
      sampleRateMs: input.sampleRateMs ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
  };
}

function siteTypeToResolved(type: {
  key: string;
  label: string;
  description: string | null;
  fields: Array<{
    key: string;
    label: string;
    description: string | null;
    valueType: string;
    required: boolean;
    resolverType: string;
    resolver: unknown;
    sampleRateMs: number | null;
    sortOrder: number;
  }>;
}): ServiceResult<ResolvedGraphType> {
  const fields: LivestoreGraphTypeFieldSchema[] = [];
  for (const field of type.fields) {
    let valueType: GraphTypeValueType;
    try {
      valueType = normalizeGraphTypeValueType(field.valueType);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Graph type field valueType is invalid";
      return errorResult("INVALID_VALUE_TYPE", `Graph type field "${field.key}" has invalid valueType: ${message}`);
    }
    fields.push({
      key: field.key,
      label: field.label,
      description: field.description ?? undefined,
      valueType,
      required: field.required,
      resolverType: field.resolverType,
      resolver: isRecord(field.resolver) ? field.resolver : { type: field.resolverType },
      sampleRateMs: field.sampleRateMs,
      sortOrder: field.sortOrder,
    });
  }

  return {
    data: {
      typeRef: graphTypeRef(null, type.key),
      source: "site",
      namespace: null,
      key: type.key,
      label: type.label,
      description: type.description,
      fields,
    },
  };
}

function integrationTypeToResolved(
  namespace: LivestoreGraphTypeNamespaceSchema,
  type: LivestoreGraphTypeSchema,
): ResolvedGraphType {
  return {
    typeRef: graphTypeRef(namespace.namespace, type.key),
    source: "integration",
    namespace: namespace.namespace,
    key: type.key,
    label: type.label,
    description: type.description ?? null,
    integration: namespace.integration,
    fields: type.fields.map((field) => ({ ...field })),
  };
}

async function getWritableSiteType(typeId: string, scope: GraphScope) {
  const type = await prisma.graphNodeType.findUnique({ where: { id: typeId }, include: { site: true } });
  if (!type) return errorResult("GRAPH_TYPE_NOT_FOUND", "Graph type not found");
  if (type.siteId !== scope.siteId || type.site.workspaceId !== scope.workspaceId)
    return errorResult("SITE_MISMATCH", "Graph type does not belong to this site");
  if (type.isDeleted) return errorResult("GRAPH_TYPE_DELETED", "Graph type has been deleted");
  return { data: type };
}

async function getWritableSiteField(fieldId: string, scope: GraphScope) {
  const field = await prisma.graphNodeTypeField.findUnique({
    where: { id: fieldId },
    include: { type: { include: { site: true } } },
  });
  if (!field) return errorResult("GRAPH_TYPE_FIELD_NOT_FOUND", "Graph type field not found");
  if (field.type.siteId !== scope.siteId || field.type.site.workspaceId !== scope.workspaceId)
    return errorResult("SITE_MISMATCH", "Graph type field does not belong to this site");
  if (field.type.isDeleted || field.isDeleted)
    return errorResult("GRAPH_TYPE_FIELD_DELETED", "Graph type field has been deleted");
  return { data: field };
}

export async function resolve(typeRef: string, scope: GraphScope): Promise<ServiceResult<ResolvedGraphType>> {
  let parsed: ReturnType<typeof parseGraphTypeRef>;
  try {
    parsed = parseGraphTypeRef(typeRef);
  } catch (err) {
    return errorResult("INVALID_GRAPH_TYPE_REF", err instanceof Error ? err.message : "Graph type ref is invalid");
  }

  if (parsed.namespace) {
    const namespace = LIVESTORE_GRAPH_TYPE_NAMESPACES.find((candidate) => candidate.namespace === parsed.namespace);
    const type = namespace?.types.find((candidate) => candidate.key === parsed.key);
    if (!namespace || !type) return errorResult("GRAPH_TYPE_NOT_FOUND", "Graph type not found");
    return { data: integrationTypeToResolved(namespace, type) };
  }

  const type = await prisma.graphNodeType.findUnique({
    where: { siteId_key: { siteId: scope.siteId, key: parsed.key } },
    include: siteTypeInclude,
  });
  if (!type || type.isDeleted) return errorResult("GRAPH_TYPE_NOT_FOUND", "Graph type not found");
  return siteTypeToResolved(type);
}

export async function catalog(scope: GraphScope): Promise<ServiceResult<unknown>> {
  const siteResult = await getGraphSiteForWorkspace(scope.siteId, scope.workspaceId);
  if ("error" in siteResult) return siteResult;

  const siteTypes = await prisma.graphNodeType.findMany({
    where: { siteId: scope.siteId, isDeleted: false },
    include: siteTypeInclude,
    orderBy: { label: "asc" },
  });
  const resolvedSiteTypes: ResolvedGraphType[] = [];
  for (const type of siteTypes) {
    const result = siteTypeToResolved(type);
    if ("error" in result) return result;
    resolvedSiteTypes.push(result.data);
  }

  return {
    data: {
      namespaces: LIVESTORE_GRAPH_TYPE_NAMESPACES.map((namespace) => ({
        namespace: namespace.namespace,
        displayName: namespace.displayName,
        integration: namespace.integration,
        description: namespace.description ?? null,
        types: namespace.types.map((type) => integrationTypeToResolved(namespace, type)),
      })),
      siteTypes: resolvedSiteTypes,
    },
  };
}

export async function create(input: CreateGraphNodeTypeInput, scope: GraphScope): Promise<ServiceResult<unknown>> {
  const siteResult = await getGraphSiteForWorkspace(scope.siteId, scope.workspaceId);
  if ("error" in siteResult) return siteResult;

  let key: string;
  try {
    key = normalizeGraphTypeToken(input.key);
  } catch (err) {
    return errorResult("INVALID_KEY", err instanceof Error ? err.message : "Graph type key is invalid");
  }
  const label = normalizeLabel(input.label);
  if (!label) return errorResult("INVALID_LABEL", "Graph type label is required");

  const normalizedFields: NormalizedGraphNodeTypeField[] = [];
  for (const field of input.fields ?? []) {
    const result = normalizeFieldInput(field);
    if ("error" in result) return result;
    normalizedFields.push(result.data);
  }

  const existing = await prisma.graphNodeType.findUnique({ where: { siteId_key: { siteId: scope.siteId, key } } });
  if (existing && !existing.isDeleted) return errorResult("GRAPH_TYPE_KEY_EXISTS", "Graph type key already exists");

  const type = await prisma.$transaction(async (tx) => {
    const next = existing
      ? await tx.graphNodeType.update({
          where: { id: existing.id },
          data: { label, description: input.description ?? null, isDeleted: false },
        })
      : await tx.graphNodeType.create({
          data: { siteId: scope.siteId, key, label, description: input.description ?? null },
        });

    for (const field of normalizedFields) {
      await tx.graphNodeTypeField.upsert({
        where: { typeId_key: { typeId: next.id, key: field.key } },
        create: {
          typeId: next.id,
          key: field.key,
          label: field.label,
          description: field.description,
          valueType: field.valueType,
          required: field.required,
          resolverType: field.resolverType,
          resolver: field.resolver as Prisma.InputJsonValue,
          sampleRateMs: field.sampleRateMs,
          sortOrder: field.sortOrder,
        },
        update: {
          label: field.label,
          description: field.description,
          valueType: field.valueType,
          required: field.required,
          resolverType: field.resolverType,
          resolver: field.resolver as Prisma.InputJsonValue,
          sampleRateMs: field.sampleRateMs,
          sortOrder: field.sortOrder,
          isDeleted: false,
        },
      });
    }

    return tx.graphNodeType.findUniqueOrThrow({ where: { id: next.id }, include: siteTypeInclude });
  });

  return { data: type };
}

export async function list(filter: ListGraphNodeTypesFilter, scope: GraphScope): Promise<ListResult<unknown>> {
  const { key, label, limit = 50, offset = 0 } = filter;
  const where = {
    siteId: scope.siteId,
    site: { workspaceId: scope.workspaceId },
    isDeleted: false,
    ...(key ? { key: normalizeGraphTypeToken(key) } : {}),
    ...(label ? { label: { contains: label, mode: "insensitive" as const } } : {}),
  };
  const [types, total] = await Promise.all([
    prisma.graphNodeType.findMany({
      where,
      include: siteTypeInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { label: "asc" },
    }),
    prisma.graphNodeType.count({ where }),
  ]);
  return { data: types, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string, scope: GraphScope): Promise<ServiceResult<unknown> | null> {
  const type = await prisma.graphNodeType.findUnique({ where: { id }, include: { ...siteTypeInclude, site: true } });
  if (!type) return null;
  if (type.siteId !== scope.siteId || type.site.workspaceId !== scope.workspaceId)
    return errorResult("SITE_MISMATCH", "Graph type does not belong to this site");
  if (type.isDeleted) return errorResult("GRAPH_TYPE_DELETED", "Graph type has been deleted");
  return { data: type };
}

export async function getSiteId(id: string, workspaceId: string): Promise<ServiceResult<string> | null> {
  const type = await prisma.graphNodeType.findUnique({ where: { id }, include: { site: true } });
  if (!type) return null;
  if (type.site.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Graph type does not belong to this workspace");
  if (type.isDeleted) return errorResult("GRAPH_TYPE_DELETED", "Graph type has been deleted");
  return { data: type.siteId };
}

export async function getFieldSiteId(id: string, workspaceId: string): Promise<ServiceResult<string> | null> {
  const field = await prisma.graphNodeTypeField.findUnique({
    where: { id },
    include: { type: { include: { site: true } } },
  });
  if (!field) return null;
  if (field.type.site.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Graph type field does not belong to this workspace");
  if (field.type.isDeleted || field.isDeleted)
    return errorResult("GRAPH_TYPE_FIELD_DELETED", "Graph type field has been deleted");
  return { data: field.type.siteId };
}

export async function update(
  id: string,
  input: UpdateGraphNodeTypeInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const currentResult = await getWritableSiteType(id, scope);
  if ("error" in currentResult) return currentResult;
  const data: Record<string, unknown> = {};

  if (input.key !== undefined) {
    let key: string;
    try {
      key = normalizeGraphTypeToken(input.key);
    } catch (err) {
      return errorResult("INVALID_KEY", err instanceof Error ? err.message : "Graph type key is invalid");
    }
    if (key !== currentResult.data.key) {
      const conflict = await prisma.graphNodeType.findUnique({ where: { siteId_key: { siteId: scope.siteId, key } } });
      if (conflict) return errorResult("GRAPH_TYPE_KEY_EXISTS", "Graph type key already exists");
    }
    data.key = key;
  }
  if (input.label !== undefined) {
    const label = normalizeLabel(input.label);
    if (!label) return errorResult("INVALID_LABEL", "Graph type label is required");
    data.label = label;
  }
  if (input.description !== undefined) data.description = input.description;

  const type = await prisma.graphNodeType.update({ where: { id }, data, include: siteTypeInclude });
  return { data: type };
}

export async function remove(id: string, scope: GraphScope): Promise<ServiceResult<{ success: true }>> {
  const currentResult = await getWritableSiteType(id, scope);
  if ("error" in currentResult) return currentResult;

  const activeNodeCount = await prisma.graphNode.count({
    where: { siteId: scope.siteId, typeRef: currentResult.data.key, isDeleted: false },
  });
  if (activeNodeCount > 0) return errorResult("GRAPH_TYPE_HAS_NODES", "Cannot delete a graph type used by nodes");

  await prisma.$transaction([
    prisma.graphNodeTypeField.updateMany({ where: { typeId: id }, data: { isDeleted: true } }),
    prisma.graphNodeType.update({ where: { id }, data: { isDeleted: true } }),
  ]);
  return { data: { success: true } };
}

export async function createField(
  input: CreateGraphNodeTypeFieldInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const typeResult = await getWritableSiteType(input.typeId, scope);
  if ("error" in typeResult) return typeResult;
  const normalized = normalizeFieldInput(input);
  if ("error" in normalized) return normalized;
  const field = await prisma.graphNodeTypeField.upsert({
    where: { typeId_key: { typeId: input.typeId, key: normalized.data.key } },
    create: {
      typeId: input.typeId,
      key: normalized.data.key,
      label: normalized.data.label,
      description: normalized.data.description,
      valueType: normalized.data.valueType,
      required: normalized.data.required,
      resolverType: normalized.data.resolverType,
      resolver: normalized.data.resolver as Prisma.InputJsonValue,
      sampleRateMs: normalized.data.sampleRateMs,
      sortOrder: normalized.data.sortOrder,
    },
    update: {
      label: normalized.data.label,
      description: normalized.data.description,
      valueType: normalized.data.valueType,
      required: normalized.data.required,
      resolverType: normalized.data.resolverType,
      resolver: normalized.data.resolver as Prisma.InputJsonValue,
      sampleRateMs: normalized.data.sampleRateMs,
      sortOrder: normalized.data.sortOrder,
      isDeleted: false,
    },
  });
  return { data: field };
}

export async function updateField(
  id: string,
  input: UpdateGraphNodeTypeFieldInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const currentResult = await getWritableSiteField(id, scope);
  if ("error" in currentResult) return currentResult;
  const current = currentResult.data;
  const data: Record<string, unknown> = {};

  if (input.key !== undefined) {
    let key: string;
    try {
      key = normalizeGraphTypeToken(input.key);
    } catch (err) {
      return errorResult("INVALID_KEY", err instanceof Error ? err.message : "Graph type field key is invalid");
    }
    if (key !== current.key) {
      const conflict = await prisma.graphNodeTypeField.findUnique({
        where: { typeId_key: { typeId: current.typeId, key } },
      });
      if (conflict) return errorResult("GRAPH_TYPE_FIELD_KEY_EXISTS", "Graph type field key already exists");
    }
    data.key = key;
  }
  if (input.label !== undefined) {
    const label = normalizeLabel(input.label);
    if (!label) return errorResult("INVALID_LABEL", "Graph type field label is required");
    data.label = label;
  }
  if (input.description !== undefined) data.description = input.description;
  if (input.valueType !== undefined) {
    try {
      data.valueType = normalizeGraphTypeValueType(input.valueType);
    } catch (err) {
      return errorResult(
        "INVALID_VALUE_TYPE",
        err instanceof Error ? err.message : "Graph type field valueType is invalid",
      );
    }
  }
  if (input.required !== undefined) data.required = input.required;
  if (input.resolverType !== undefined) {
    const resolverType = normalizeResolverType(input.resolverType);
    if (!resolverType) return errorResult("INVALID_RESOLVER_TYPE", "Graph type field resolverType is required");
    data.resolverType = resolverType;
  }
  if (input.resolver !== undefined) {
    if (!isRecord(input.resolver))
      return errorResult("INVALID_RESOLVER", "Graph type field resolver must be an object");
    data.resolver = input.resolver as Prisma.InputJsonValue;
  }
  if (input.sampleRateMs !== undefined) data.sampleRateMs = input.sampleRateMs;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

  const field = await prisma.graphNodeTypeField.update({ where: { id }, data });
  return { data: field };
}

export async function removeField(id: string, scope: GraphScope): Promise<ServiceResult<{ success: true }>> {
  const currentResult = await getWritableSiteField(id, scope);
  if ("error" in currentResult) return currentResult;
  await prisma.graphNodeTypeField.update({ where: { id }, data: { isDeleted: true } });
  return { data: { success: true } };
}
