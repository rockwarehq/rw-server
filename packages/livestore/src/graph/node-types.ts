import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import {
  LIVESTORE_GRAPH_TYPE_NAMESPACES,
  graphTypeRef,
  normalizeGraphTypeInputValueType,
  normalizeGraphTypeValueType,
  normalizeGraphTypeToken,
  parseGraphTypeRef,
  type GraphTypeInputValueType,
  type GraphTypeValueType,
  type LivestoreGraphTypeFacetSchema,
  type LivestoreGraphTypeFieldSchema,
  type LivestoreGraphTypeInputSchema,
  type LivestoreGraphTypeNamespaceSchema,
  type LivestoreGraphTypeSchema,
} from "@rw/runtime/livestore-graph-types";

import { systemEntityCatalogEntryByKey } from "@rw/services/entity/registry";
import { getGraphSiteForWorkspace } from "./scope.js";
import { errorResult, type GraphScope, type ListResult, type ServiceResult } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INPUT_TEMPLATE_PATTERN = /^\$(?:context|input)\.([a-zA-Z0-9_-]+)$/;

export interface GraphNodeTypeInputConfig {
  key: string;
  label: string;
  description?: string | null;
  valueType: GraphTypeInputValueType;
  entityKey?: string | null;
  required?: boolean;
  sortOrder?: number;
}

export interface GraphNodeTypeFacetInput {
  key: string;
  label: string;
  description?: string | null;
  valueType?: GraphTypeValueType | null;
  required?: boolean;
  resolverType: string;
  resolver: Record<string, unknown>;
  sortOrder?: number;
}

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
  inputs?: GraphNodeTypeInputConfig[];
  facets?: GraphNodeTypeFacetInput[];
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

export interface CreateGraphNodeTypeInputInput extends GraphNodeTypeInputConfig {
  typeId: string;
}

export interface CreateGraphNodeTypeFacetInput extends GraphNodeTypeFacetInput {
  typeId: string;
}

export interface UpdateGraphNodeTypeInputInput {
  key?: string;
  label?: string;
  description?: string | null;
  valueType?: GraphTypeInputValueType;
  entityKey?: string | null;
  required?: boolean;
  sortOrder?: number;
}

export interface UpdateGraphNodeTypeFacetInput {
  key?: string;
  label?: string;
  description?: string | null;
  valueType?: GraphTypeValueType | null;
  required?: boolean;
  resolverType?: string;
  resolver?: Record<string, unknown>;
  sortOrder?: number;
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
  inputs: LivestoreGraphTypeInputSchema[];
  facets: LivestoreGraphTypeFacetSchema[];
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

interface NormalizedGraphNodeTypeInput {
  key: string;
  label: string;
  description: string | null;
  valueType: GraphTypeInputValueType;
  entityKey: string | null;
  required: boolean;
  sortOrder: number;
}

interface NormalizedGraphNodeTypeFacet {
  key: string;
  label: string;
  description: string | null;
  valueType: GraphTypeValueType | null;
  required: boolean;
  resolverType: string;
  resolver: Record<string, unknown>;
  sortOrder: number;
}

const siteTypeInclude = {
  inputs: {
    where: { isDeleted: false },
    orderBy: [{ sortOrder: "asc" as const }, { key: "asc" as const }],
  },
  facets: {
    where: { isDeleted: false },
    orderBy: [{ sortOrder: "asc" as const }, { key: "asc" as const }],
  },
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

function normalizeEntityKey(value: string | null | undefined): string | null {
  const entityKey = value?.trim();
  return entityKey ? entityKey : null;
}

async function validateEntityCatalogKey(entityKey: string, scope: GraphScope) {
  if (systemEntityCatalogEntryByKey(entityKey, false)) return { data: entityKey };

  const schema = await prisma.objectSchema.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      source: "DOCUMENT",
      isDeleted: false,
      OR: [...(UUID_PATTERN.test(entityKey) ? [{ id: entityKey }] : []), { key: entityKey }],
    },
    select: { id: true },
  });
  return schema
    ? { data: entityKey }
    : errorResult("ENTITY_CATALOG_NOT_FOUND", `Entity catalog key not found: ${entityKey}`);
}

async function validateEntityCatalogPath(entityKey: string, path: string, scope: GraphScope) {
  const systemEntry = systemEntityCatalogEntryByKey(entityKey, true);
  if (systemEntry?.fields) {
    const field = systemEntry.fields.find((candidate) => candidate.key === path || candidate.path === path);
    return field ? { data: field } : errorResult("ENTITY_PATH_NOT_FOUND", `Entity path not found: ${path}`);
  }

  const schema = await prisma.objectSchema.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      source: "DOCUMENT",
      isDeleted: false,
      OR: [...(UUID_PATTERN.test(entityKey) ? [{ id: entityKey }] : []), { key: entityKey }],
    },
    include: { fields: { where: { isDeleted: false } } },
  });
  if (!schema) return errorResult("ENTITY_CATALOG_NOT_FOUND", `Entity catalog key not found: ${entityKey}`);
  const field = schema.fields.find((candidate) => candidate.key === path || candidate.name === path);
  return field ? { data: field } : errorResult("ENTITY_PATH_NOT_FOUND", `Entity path not found: ${path}`);
}

async function normalizeInputConfig(
  input: GraphNodeTypeInputConfig,
  scope: GraphScope,
): Promise<ServiceResult<NormalizedGraphNodeTypeInput>> {
  let key: string;
  try {
    key = normalizeGraphTypeToken(input.key);
  } catch (err) {
    return errorResult("INVALID_KEY", err instanceof Error ? err.message : "Graph type input key is invalid");
  }
  const label = normalizeLabel(input.label);
  if (!label) return errorResult("INVALID_LABEL", "Graph type input label is required");

  let valueType: GraphTypeInputValueType;
  try {
    valueType = normalizeGraphTypeInputValueType(input.valueType);
  } catch (err) {
    return errorResult(
      "INVALID_VALUE_TYPE",
      err instanceof Error ? err.message : "Graph type input valueType is invalid",
    );
  }

  const entityKey = normalizeEntityKey(input.entityKey);
  if (valueType === "entityRef") {
    if (!entityKey) return errorResult("INVALID_ENTITY_KEY", "Graph type entityRef input requires entityKey");
    const entityResult = await validateEntityCatalogKey(entityKey, scope);
    if ("error" in entityResult) return entityResult;
  } else if (entityKey) {
    return errorResult("INVALID_ENTITY_KEY", "Graph type input entityKey is only valid for entityRef inputs");
  }

  return {
    data: {
      key,
      label,
      description: input.description ?? null,
      valueType,
      entityKey,
      required: input.required ?? false,
      sortOrder: input.sortOrder ?? 0,
    },
  };
}

async function validateFacetResolver(args: {
  resolverType: string;
  resolver: Record<string, unknown>;
  inputs: NormalizedGraphNodeTypeInput[];
  scope: GraphScope;
}) {
  if (args.resolverType !== "entity") {
    return errorResult("INVALID_RESOLVER_TYPE", "Graph type facet resolverType must be entity");
  }
  if (args.resolver.type !== "entity") {
    return errorResult("INVALID_RESOLVER", "Graph type facet resolver type must be entity");
  }
  if (!isRecord(args.resolver.entityRef)) {
    return errorResult("INVALID_RESOLVER", "Graph type facet resolver entityRef is required");
  }
  const entityKey = normalizeEntityKey(args.resolver.entityRef.key as string | null | undefined);
  const entityId = args.resolver.entityRef.id;
  const path = args.resolver.path;
  if (!entityKey) return errorResult("INVALID_RESOLVER", "Graph type facet resolver entityRef.key is required");
  if (typeof entityId !== "string" || !entityId.trim()) {
    return errorResult("INVALID_RESOLVER", "Graph type facet resolver entityRef.id is required");
  }
  if (typeof path !== "string" || !path.trim()) {
    return errorResult("INVALID_RESOLVER", "Graph type facet resolver path is required");
  }
  const entityIdText = entityId.trim();
  const pathText = path.trim();

  const entityResult = await validateEntityCatalogKey(entityKey, args.scope);
  if ("error" in entityResult) return entityResult;
  const pathResult = await validateEntityCatalogPath(entityKey, pathText, args.scope);
  if ("error" in pathResult) return pathResult;

  const normalizedResolver = {
    ...args.resolver,
    type: "entity",
    entityRef: {
      ...args.resolver.entityRef,
      key: entityKey,
      id: entityIdText,
    },
    path: pathText,
  };

  const inputMatch = INPUT_TEMPLATE_PATTERN.exec(entityIdText);
  if (!inputMatch) return { data: normalizedResolver };

  const inputKey = normalizeGraphTypeToken(inputMatch[1] ?? "");
  const input = args.inputs.find((candidate) => candidate.key === inputKey);
  if (!input) return errorResult("INVALID_RESOLVER", `Graph type facet references unknown input: ${inputKey}`);
  if (input.valueType !== "entityRef") {
    return errorResult("INVALID_RESOLVER", `Graph type facet input "${inputKey}" must be an entityRef`);
  }
  if (input.entityKey !== entityKey) {
    return errorResult("INVALID_RESOLVER", `Graph type facet input "${inputKey}" entityKey does not match resolver`);
  }
  return { data: normalizedResolver };
}

async function normalizeFacetInput(
  input: GraphNodeTypeFacetInput,
  scope: GraphScope,
  inputs: NormalizedGraphNodeTypeInput[],
): Promise<ServiceResult<NormalizedGraphNodeTypeFacet>> {
  let key: string;
  try {
    key = normalizeGraphTypeToken(input.key);
  } catch (err) {
    return errorResult("INVALID_KEY", err instanceof Error ? err.message : "Graph type facet key is invalid");
  }
  const label = normalizeLabel(input.label);
  if (!label) return errorResult("INVALID_LABEL", "Graph type facet label is required");
  const resolverType = normalizeResolverType(input.resolverType);
  if (!resolverType) return errorResult("INVALID_RESOLVER_TYPE", "Graph type facet resolverType is required");
  if (!isRecord(input.resolver)) return errorResult("INVALID_RESOLVER", "Graph type facet resolver must be an object");

  let valueType: GraphTypeValueType | null = null;
  if (input.valueType !== undefined && input.valueType !== null) {
    try {
      valueType = normalizeGraphTypeValueType(input.valueType);
    } catch (err) {
      return errorResult(
        "INVALID_VALUE_TYPE",
        err instanceof Error ? err.message : "Graph type facet valueType is invalid",
      );
    }
  }

  const resolverResult = await validateFacetResolver({ resolverType, resolver: input.resolver, inputs, scope });
  if ("error" in resolverResult) return resolverResult;

  return {
    data: {
      key,
      label,
      description: input.description ?? null,
      valueType,
      required: input.required ?? false,
      resolverType,
      resolver: resolverResult.data,
      sortOrder: input.sortOrder ?? 0,
    },
  };
}

function resolverReferencesInput(value: unknown, inputKey: string): boolean {
  if (typeof value === "string") {
    const match = INPUT_TEMPLATE_PATTERN.exec(value.trim());
    return Boolean(match && normalizeGraphTypeToken(match[1] ?? "") === inputKey);
  }
  if (Array.isArray(value)) return value.some((item) => resolverReferencesInput(item, inputKey));
  if (!isRecord(value)) return false;
  return Object.values(value).some((item) => resolverReferencesInput(item, inputKey));
}

async function validateExistingFacetsForInputs(
  typeId: string,
  inputs: NormalizedGraphNodeTypeInput[],
  scope: GraphScope,
): Promise<ServiceResult<{ success: true }>> {
  const facets = await prisma.graphNodeTypeFacet.findMany({ where: { typeId, isDeleted: false } });
  for (const facet of facets) {
    const result = await normalizeFacetInput(
      {
        key: facet.key,
        label: facet.label,
        description: facet.description,
        valueType: facet.valueType as GraphTypeValueType | null,
        required: facet.required,
        resolverType: facet.resolverType,
        resolver: isRecord(facet.resolver) ? facet.resolver : {},
        sortOrder: facet.sortOrder,
      },
      scope,
      inputs,
    );
    if ("error" in result) return result;
  }
  return { data: { success: true } };
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
  inputs: Array<{
    key: string;
    label: string;
    description: string | null;
    valueType: string;
    entityKey: string | null;
    required: boolean;
    sortOrder: number;
  }>;
  facets: Array<{
    key: string;
    label: string;
    description: string | null;
    valueType: string | null;
    required: boolean;
    resolverType: string;
    resolver: unknown;
    sortOrder: number;
  }>;
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
  const inputs: LivestoreGraphTypeInputSchema[] = [];
  for (const input of type.inputs) {
    let valueType: GraphTypeInputValueType;
    try {
      valueType = normalizeGraphTypeInputValueType(input.valueType);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Graph type input valueType is invalid";
      return errorResult("INVALID_VALUE_TYPE", `Graph type input "${input.key}" has invalid valueType: ${message}`);
    }
    inputs.push({
      key: input.key,
      label: input.label,
      description: input.description ?? undefined,
      valueType,
      entityKey: input.entityKey ?? undefined,
      required: input.required,
      sortOrder: input.sortOrder,
    });
  }

  const facets: LivestoreGraphTypeFacetSchema[] = [];
  for (const facet of type.facets) {
    let valueType: GraphTypeValueType | undefined;
    if (facet.valueType) {
      try {
        valueType = normalizeGraphTypeValueType(facet.valueType);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Graph type facet valueType is invalid";
        return errorResult("INVALID_VALUE_TYPE", `Graph type facet "${facet.key}" has invalid valueType: ${message}`);
      }
    }
    facets.push({
      key: facet.key,
      label: facet.label,
      description: facet.description ?? undefined,
      valueType,
      required: facet.required,
      resolverType: facet.resolverType,
      resolver: isRecord(facet.resolver) ? facet.resolver : { type: facet.resolverType },
      sortOrder: facet.sortOrder,
    });
  }

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
      inputs,
      facets,
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
    inputs: (type.inputs ?? []).map((input) => ({ ...input })),
    facets: (type.facets ?? []).map((facet) => ({ ...facet, resolver: { ...facet.resolver } })),
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

async function getWritableSiteInput(inputId: string, scope: GraphScope) {
  const input = await prisma.graphNodeTypeInput.findUnique({
    where: { id: inputId },
    include: { type: { include: { site: true } } },
  });
  if (!input) return errorResult("GRAPH_TYPE_INPUT_NOT_FOUND", "Graph type input not found");
  if (input.type.siteId !== scope.siteId || input.type.site.workspaceId !== scope.workspaceId)
    return errorResult("SITE_MISMATCH", "Graph type input does not belong to this site");
  if (input.type.isDeleted || input.isDeleted)
    return errorResult("GRAPH_TYPE_INPUT_DELETED", "Graph type input has been deleted");
  return { data: input };
}

async function getWritableSiteFacet(facetId: string, scope: GraphScope) {
  const facet = await prisma.graphNodeTypeFacet.findUnique({
    where: { id: facetId },
    include: { type: { include: { site: true } } },
  });
  if (!facet) return errorResult("GRAPH_TYPE_FACET_NOT_FOUND", "Graph type facet not found");
  if (facet.type.siteId !== scope.siteId || facet.type.site.workspaceId !== scope.workspaceId)
    return errorResult("SITE_MISMATCH", "Graph type facet does not belong to this site");
  if (facet.type.isDeleted || facet.isDeleted)
    return errorResult("GRAPH_TYPE_FACET_DELETED", "Graph type facet has been deleted");
  return { data: facet };
}

function dbInputToNormalized(input: {
  key: string;
  label: string;
  description: string | null;
  valueType: string;
  entityKey: string | null;
  required: boolean;
  sortOrder: number;
}): ServiceResult<NormalizedGraphNodeTypeInput> {
  let valueType: GraphTypeInputValueType;
  try {
    valueType = normalizeGraphTypeInputValueType(input.valueType);
  } catch (err) {
    return errorResult(
      "INVALID_VALUE_TYPE",
      err instanceof Error ? err.message : "Graph type input valueType is invalid",
    );
  }
  return {
    data: {
      key: input.key,
      label: input.label,
      description: input.description,
      valueType,
      entityKey: input.entityKey,
      required: input.required,
      sortOrder: input.sortOrder,
    },
  };
}

async function normalizedInputsForType(
  typeId: string,
  options?: {
    replaceId?: string;
    replacement?: NormalizedGraphNodeTypeInput;
    removeId?: string;
  },
): Promise<ServiceResult<NormalizedGraphNodeTypeInput[]>> {
  const inputs = await prisma.graphNodeTypeInput.findMany({
    where: { typeId, isDeleted: false },
    orderBy: [{ sortOrder: "asc" as const }, { key: "asc" as const }],
  });
  const normalized: NormalizedGraphNodeTypeInput[] = [];
  let replaced = false;
  for (const input of inputs) {
    if (options?.removeId === input.id) continue;
    if (options?.replacement && options.replaceId === input.id) {
      normalized.push(options.replacement);
      replaced = true;
      continue;
    }
    const result = dbInputToNormalized(input);
    if ("error" in result) return result;
    normalized.push(result.data);
  }
  if (options?.replacement && !replaced) normalized.push(options.replacement);
  return { data: normalized };
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

  const normalizedInputs: NormalizedGraphNodeTypeInput[] = [];
  for (const typeInput of input.inputs ?? []) {
    const result = await normalizeInputConfig(typeInput, scope);
    if ("error" in result) return result;
    normalizedInputs.push(result.data);
  }

  const normalizedFacets: NormalizedGraphNodeTypeFacet[] = [];
  for (const facet of input.facets ?? []) {
    const result = await normalizeFacetInput(facet, scope, normalizedInputs);
    if ("error" in result) return result;
    normalizedFacets.push(result.data);
  }

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

    for (const typeInput of normalizedInputs) {
      await tx.graphNodeTypeInput.upsert({
        where: { typeId_key: { typeId: next.id, key: typeInput.key } },
        create: {
          typeId: next.id,
          key: typeInput.key,
          label: typeInput.label,
          description: typeInput.description,
          valueType: typeInput.valueType,
          entityKey: typeInput.entityKey,
          required: typeInput.required,
          sortOrder: typeInput.sortOrder,
        },
        update: {
          label: typeInput.label,
          description: typeInput.description,
          valueType: typeInput.valueType,
          entityKey: typeInput.entityKey,
          required: typeInput.required,
          sortOrder: typeInput.sortOrder,
          isDeleted: false,
        },
      });
    }

    for (const facet of normalizedFacets) {
      await tx.graphNodeTypeFacet.upsert({
        where: { typeId_key: { typeId: next.id, key: facet.key } },
        create: {
          typeId: next.id,
          key: facet.key,
          label: facet.label,
          description: facet.description,
          valueType: facet.valueType,
          required: facet.required,
          resolverType: facet.resolverType,
          resolver: facet.resolver as Prisma.InputJsonValue,
          sortOrder: facet.sortOrder,
        },
        update: {
          label: facet.label,
          description: facet.description,
          valueType: facet.valueType,
          required: facet.required,
          resolverType: facet.resolverType,
          resolver: facet.resolver as Prisma.InputJsonValue,
          sortOrder: facet.sortOrder,
          isDeleted: false,
        },
      });
    }

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

export async function getInputSiteId(id: string, workspaceId: string): Promise<ServiceResult<string> | null> {
  const input = await prisma.graphNodeTypeInput.findUnique({
    where: { id },
    include: { type: { include: { site: true } } },
  });
  if (!input) return null;
  if (input.type.site.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Graph type input does not belong to this workspace");
  if (input.type.isDeleted || input.isDeleted)
    return errorResult("GRAPH_TYPE_INPUT_DELETED", "Graph type input has been deleted");
  return { data: input.type.siteId };
}

export async function getFacetSiteId(id: string, workspaceId: string): Promise<ServiceResult<string> | null> {
  const facet = await prisma.graphNodeTypeFacet.findUnique({
    where: { id },
    include: { type: { include: { site: true } } },
  });
  if (!facet) return null;
  if (facet.type.site.workspaceId !== workspaceId)
    return errorResult("WORKSPACE_MISMATCH", "Graph type facet does not belong to this workspace");
  if (facet.type.isDeleted || facet.isDeleted)
    return errorResult("GRAPH_TYPE_FACET_DELETED", "Graph type facet has been deleted");
  return { data: facet.type.siteId };
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
    prisma.graphNodeTypeInput.updateMany({ where: { typeId: id }, data: { isDeleted: true } }),
    prisma.graphNodeTypeFacet.updateMany({ where: { typeId: id }, data: { isDeleted: true } }),
    prisma.graphNodeTypeField.updateMany({ where: { typeId: id }, data: { isDeleted: true } }),
    prisma.graphNodeType.update({ where: { id }, data: { isDeleted: true } }),
  ]);
  return { data: { success: true } };
}

async function refreshTypeFacetsBestEffort(typeId: string, scope: GraphScope): Promise<void> {
  const type = await prisma.graphNodeType.findUnique({ where: { id: typeId }, select: { key: true, isDeleted: true } });
  if (!type || type.isDeleted) return;
  try {
    const nodes = await import("./nodes.js");
    const result = await nodes.refreshFacetsForType({ typeRef: type.key, scope });
    if ("error" in result) console.error("[graph] node facet refresh failed", result);
  } catch (err) {
    console.error("[graph] node facet refresh failed", err);
  }
}

export async function createInput(
  input: CreateGraphNodeTypeInputInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const typeResult = await getWritableSiteType(input.typeId, scope);
  if ("error" in typeResult) return typeResult;
  const normalized = await normalizeInputConfig(input, scope);
  if ("error" in normalized) return normalized;

  const typeInput = await prisma.graphNodeTypeInput.upsert({
    where: { typeId_key: { typeId: input.typeId, key: normalized.data.key } },
    create: {
      typeId: input.typeId,
      key: normalized.data.key,
      label: normalized.data.label,
      description: normalized.data.description,
      valueType: normalized.data.valueType,
      entityKey: normalized.data.entityKey,
      required: normalized.data.required,
      sortOrder: normalized.data.sortOrder,
    },
    update: {
      label: normalized.data.label,
      description: normalized.data.description,
      valueType: normalized.data.valueType,
      entityKey: normalized.data.entityKey,
      required: normalized.data.required,
      sortOrder: normalized.data.sortOrder,
      isDeleted: false,
    },
  });
  return { data: typeInput };
}

export async function updateInput(
  id: string,
  input: UpdateGraphNodeTypeInputInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const currentResult = await getWritableSiteInput(id, scope);
  if ("error" in currentResult) return currentResult;
  const current = currentResult.data;

  const candidate: GraphNodeTypeInputConfig = {
    key: input.key ?? current.key,
    label: input.label ?? current.label,
    description: input.description === undefined ? current.description : input.description,
    valueType: input.valueType ?? (current.valueType as GraphTypeInputValueType),
    entityKey: input.entityKey === undefined ? current.entityKey : input.entityKey,
    required: input.required ?? current.required,
    sortOrder: input.sortOrder ?? current.sortOrder,
  };
  const normalized = await normalizeInputConfig(candidate, scope);
  if ("error" in normalized) return normalized;
  if (normalized.data.key !== current.key) {
    const conflict = await prisma.graphNodeTypeInput.findUnique({
      where: { typeId_key: { typeId: current.typeId, key: normalized.data.key } },
    });
    if (conflict) return errorResult("GRAPH_TYPE_INPUT_KEY_EXISTS", "Graph type input key already exists");
  }

  const normalizedInputs = await normalizedInputsForType(current.typeId, {
    replaceId: id,
    replacement: normalized.data,
  });
  if ("error" in normalizedInputs) return normalizedInputs;
  const facetValidation = await validateExistingFacetsForInputs(current.typeId, normalizedInputs.data, scope);
  if ("error" in facetValidation) return facetValidation;

  const typeInput = await prisma.graphNodeTypeInput.update({
    where: { id },
    data: {
      key: normalized.data.key,
      label: normalized.data.label,
      description: normalized.data.description,
      valueType: normalized.data.valueType,
      entityKey: normalized.data.entityKey,
      required: normalized.data.required,
      sortOrder: normalized.data.sortOrder,
    },
  });
  return { data: typeInput };
}

export async function removeInput(id: string, scope: GraphScope): Promise<ServiceResult<{ success: true }>> {
  const currentResult = await getWritableSiteInput(id, scope);
  if ("error" in currentResult) return currentResult;
  const current = currentResult.data;
  const referencingFacet = await prisma.graphNodeTypeFacet.findFirst({
    where: { typeId: current.typeId, isDeleted: false },
  });
  if (referencingFacet && resolverReferencesInput(referencingFacet.resolver, current.key)) {
    return errorResult("GRAPH_TYPE_INPUT_IN_USE", "Cannot delete a graph type input used by a facet");
  }
  if (referencingFacet) {
    const facets = await prisma.graphNodeTypeFacet.findMany({ where: { typeId: current.typeId, isDeleted: false } });
    if (facets.some((facet) => resolverReferencesInput(facet.resolver, current.key))) {
      return errorResult("GRAPH_TYPE_INPUT_IN_USE", "Cannot delete a graph type input used by a facet");
    }
  }
  await prisma.graphNodeTypeInput.update({ where: { id }, data: { isDeleted: true } });
  return { data: { success: true } };
}

export async function createFacet(
  input: CreateGraphNodeTypeFacetInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const typeResult = await getWritableSiteType(input.typeId, scope);
  if ("error" in typeResult) return typeResult;
  const inputs = await normalizedInputsForType(input.typeId);
  if ("error" in inputs) return inputs;
  const normalized = await normalizeFacetInput(input, scope, inputs.data);
  if ("error" in normalized) return normalized;

  const facet = await prisma.graphNodeTypeFacet.upsert({
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
      sortOrder: normalized.data.sortOrder,
    },
    update: {
      label: normalized.data.label,
      description: normalized.data.description,
      valueType: normalized.data.valueType,
      required: normalized.data.required,
      resolverType: normalized.data.resolverType,
      resolver: normalized.data.resolver as Prisma.InputJsonValue,
      sortOrder: normalized.data.sortOrder,
      isDeleted: false,
    },
  });
  await refreshTypeFacetsBestEffort(input.typeId, scope);
  return { data: facet };
}

export async function updateFacet(
  id: string,
  input: UpdateGraphNodeTypeFacetInput,
  scope: GraphScope,
): Promise<ServiceResult<unknown>> {
  const currentResult = await getWritableSiteFacet(id, scope);
  if ("error" in currentResult) return currentResult;
  const current = currentResult.data;
  const inputs = await normalizedInputsForType(current.typeId);
  if ("error" in inputs) return inputs;
  const candidate: GraphNodeTypeFacetInput = {
    key: input.key ?? current.key,
    label: input.label ?? current.label,
    description: input.description === undefined ? current.description : input.description,
    valueType: input.valueType === undefined ? (current.valueType as GraphTypeValueType | null) : input.valueType,
    required: input.required ?? current.required,
    resolverType: input.resolverType ?? current.resolverType,
    resolver: input.resolver ?? (isRecord(current.resolver) ? current.resolver : {}),
    sortOrder: input.sortOrder ?? current.sortOrder,
  };
  const normalized = await normalizeFacetInput(candidate, scope, inputs.data);
  if ("error" in normalized) return normalized;
  if (normalized.data.key !== current.key) {
    const conflict = await prisma.graphNodeTypeFacet.findUnique({
      where: { typeId_key: { typeId: current.typeId, key: normalized.data.key } },
    });
    if (conflict) return errorResult("GRAPH_TYPE_FACET_KEY_EXISTS", "Graph type facet key already exists");
  }

  const facet = await prisma.graphNodeTypeFacet.update({
    where: { id },
    data: {
      key: normalized.data.key,
      label: normalized.data.label,
      description: normalized.data.description,
      valueType: normalized.data.valueType,
      required: normalized.data.required,
      resolverType: normalized.data.resolverType,
      resolver: normalized.data.resolver as Prisma.InputJsonValue,
      sortOrder: normalized.data.sortOrder,
    },
  });
  await refreshTypeFacetsBestEffort(current.typeId, scope);
  return { data: facet };
}

export async function removeFacet(id: string, scope: GraphScope): Promise<ServiceResult<{ success: true }>> {
  const currentResult = await getWritableSiteFacet(id, scope);
  if ("error" in currentResult) return currentResult;
  await prisma.graphNodeTypeFacet.update({ where: { id }, data: { isDeleted: true } });
  await refreshTypeFacetsBestEffort(currentResult.data.typeId, scope);
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
