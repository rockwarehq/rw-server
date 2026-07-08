import prisma from "@rw/db";

import { systemEntityCatalogEntryByKey } from "@rw/services/entity/registry";
import type { EntityCatalogField } from "@rw/services/entity/registry.types";
import { livestoreResolverConfigSchema } from "../catalog/resolver-schemas.js";
import { graphNodeSiteWhere } from "./scope.js";
import { validateExpression } from "../resolvers/expr-sandbox.js";
import { errorResult, type GraphScope, type ServiceResult } from "./types.js";
const PREFIXED_UUID_PATTERN = /\bp_([0-9a-f]{8}_[0-9a-f]{4}_[1-8][0-9a-f]{3}_[89ab][0-9a-f]{3}_[0-9a-f]{12})\b/gi;
// Any property-shaped symbol the expression sandbox will accept at eval time.
const PROPERTY_SYMBOL_PATTERN = /\bp_\w+\b/g;
const PREFIXED_UUID_EXACT_PATTERN = /^p_[0-9a-f]{8}_[0-9a-f]{4}_[1-8][0-9a-f]{3}_[89ab][0-9a-f]{3}_[0-9a-f]{12}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function prefixedPropertyId(propertyId: string): string {
  return `p_${propertyId.replaceAll("-", "_")}`;
}

export function extractExpressionDependencyIds(expression: string): string[] {
  const ids = new Set<string>();
  for (const match of expression.matchAll(PREFIXED_UUID_PATTERN)) {
    ids.add(match[1].replaceAll("_", "-"));
  }
  return [...ids];
}

// The sandbox accepts any p_* symbol, but only UUID-shaped ones become graph
// edges — anything else would save as a zombie expression with no dependencies
// that never recomputes and evaluates against an unbound symbol.
function findMalformedPropertySymbols(expression: string): string[] {
  const malformed = new Set<string>();
  for (const match of expression.matchAll(PROPERTY_SYMBOL_PATTERN)) {
    if (!PREFIXED_UUID_EXACT_PATTERN.test(match[0])) malformed.add(match[0]);
  }
  return [...malformed];
}

// Validate an entity path against the catalog (system entry fields or user
// ObjectSchema fields). Shared with the facet materializer in nodes.ts.
export async function entityCatalogField(
  entityKey: string,
  path: string,
  scope: GraphScope,
): Promise<ServiceResult<EntityCatalogField>> {
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
  if (!schema) return errorResult("ENTITY_REF_SCHEMA_NOT_FOUND", "Entity reference schema was not found");

  const field = schema.fields.find((candidate) => candidate.key === path || candidate.name === path);
  if (!field) return errorResult("ENTITY_PATH_NOT_FOUND", `Entity path not found: ${path}`);
  return {
    data: {
      key: field.key,
      name: field.key,
      label: field.label,
      type: field.type,
      description: field.description,
      required: field.required,
      isList: field.isList,
      path: field.key,
      relation: field.refSchemaId ? { key: field.key, targetKey: field.refSchemaId } : null,
      sortOrder: field.sortOrder,
    },
  };
}

async function assertPropertiesInSite(propertyIds: readonly string[], scope: GraphScope) {
  const uniqueIds = [...new Set(propertyIds)];
  if (uniqueIds.length === 0) return null;
  const properties = await prisma.graphProperty.findMany({
    where: {
      id: { in: uniqueIds },
      isDeleted: false,
      node: graphNodeSiteWhere(scope),
    },
    select: { id: true, resolverType: true },
  });
  if (properties.length !== uniqueIds.length)
    return errorResult("DEPENDENCY_NOT_FOUND", "One or more dependencies were not found");
  return { data: properties };
}

async function assertKnownEntityInSite(entityType: string, entityId: string, scope: GraphScope) {
  const type = entityType.toUpperCase();
  if (type === "SITE") {
    if (entityId !== scope.siteId)
      return errorResult("ENTITY_SITE_MISMATCH", "Metric entity is outside this graph site");
    const site = await prisma.site.findFirst({ where: { id: entityId, workspaceId: scope.workspaceId } });
    return site ? null : errorResult("ENTITY_SITE_MISMATCH", "Metric entity is outside this graph site");
  }
  if (type === "WORKCENTER") {
    const workcenter = await prisma.workcenter.findFirst({
      where: { id: entityId, siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
    });
    return workcenter ? null : errorResult("ENTITY_SITE_MISMATCH", "Metric entity is outside this graph site");
  }
  if (type === "STATION") {
    const station = await prisma.station.findFirst({
      where: { id: entityId, siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
    });
    return station ? null : errorResult("ENTITY_SITE_MISMATCH", "Metric entity is outside this graph site");
  }
  if (type === "JOB") {
    const job = await prisma.job.findFirst({
      where: { id: entityId, siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
    });
    return job ? null : errorResult("ENTITY_SITE_MISMATCH", "Metric entity is outside this graph site");
  }
  return errorResult("INVALID_RESOLVER", "resolver entityType must be Site, Workcenter, Station, or Job");
}

// User-defined (jsonb) entity: the catalog key is an ObjectSchema, entityId an ObjectInstance.
async function assertKnownUserEntityInSite(entityKey: string, entityId: string, scope: GraphScope) {
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
  if (!schema) return errorResult("INVALID_RESOLVER", `entity resolver entityType is not a known entity: ${entityKey}`);
  const instance = await prisma.objectInstance.findFirst({
    where: { id: entityId, schemaId: schema.id, siteId: scope.siteId, isDeleted: false },
    select: { id: true },
  });
  return instance ? null : errorResult("ENTITY_REF_NOT_FOUND", "entity resolver entityId was not found in this site");
}

async function validateRollupParent(parent: unknown, scope: GraphScope) {
  if (parent === undefined) return null;
  if (!isRecord(parent) || typeof parent.model !== "string" || typeof parent.id !== "string") {
    return errorResult("INVALID_RESOLVER", "rollup parent must include model and id");
  }
  return assertKnownEntityInSite(parent.model, parent.id, scope);
}

export async function validateResolverConfig(args: {
  resolverType: string;
  resolver: Record<string, unknown>;
  scope: GraphScope;
  // In-batch sibling ids: dependencies on these skip the "exists in site" check.
  knownPropertyIds?: ReadonlySet<string>;
}): Promise<
  { data: { resolver: Record<string, unknown>; dependencyIds: string[] } } | { error: string; code: string }
> {
  const resolverType = args.resolverType.trim();
  const withType: Record<string, unknown> & { type: string } = {
    ...args.resolver,
    type: typeof args.resolver.type === "string" ? args.resolver.type : resolverType,
  };
  if (withType.type !== resolverType)
    return errorResult("RESOLVER_TYPE_MISMATCH", "resolver.type must match resolverType");

  // Structural layer: the shared zod schemas (also served to builders as JSON
  // Schema via the capability manifest) are the single source of truth for
  // field shapes and ranges. Per-field error messages match the historical
  // strings. Referential checks (entities/dependencies exist in the site)
  // follow below per type.
  const schema = livestoreResolverConfigSchema(resolverType);
  if (!schema) return errorResult("INVALID_RESOLVER_TYPE", `Unsupported resolverType "${resolverType}"`);
  const parsed = schema.safeParse(withType);
  if (!parsed.success) {
    return errorResult(
      "INVALID_RESOLVER",
      parsed.error.issues[0]?.message ?? `${resolverType} resolver is invalid`,
    );
  }
  const resolver = parsed.data as Record<string, unknown> & { type: string };

  if (resolverType === "tag") {
    return { data: { resolver, dependencyIds: [] } };
  }

  if (resolverType === "metric") {
    const entityError = await assertKnownEntityInSite(
      resolver.entityType as string,
      resolver.entityId as string,
      args.scope,
    );
    if (entityError) return entityError;
    return { data: { resolver, dependencyIds: [] } };
  }

  if (resolverType === "entity") {
    const entityType = resolver.entityType as string;
    const entityId = resolver.entityId as string;
    const path = resolver.path as string;
    const entry = systemEntityCatalogEntryByKey(entityType, false);
    const entityError = entry?.model
      ? await assertKnownEntityInSite(entry.model, entityId, args.scope)
      : await assertKnownUserEntityInSite(entityType, entityId, args.scope);
    if (entityError) return entityError;
    // Unknown paths would resolve to null with quality "good" forever; reject
    // them at save time. "id" and "*" are runtime specials outside the catalog.
    if (path !== "id" && path !== "*") {
      const fieldResult = await entityCatalogField(entityType, path, args.scope);
      if ("error" in fieldResult) return fieldResult;
    }
    return { data: { resolver, dependencyIds: [] } };
  }

  if (resolverType === "expr") {
    const expression = resolver.expression as string;
    const malformed = findMalformedPropertySymbols(expression);
    if (malformed.length > 0) {
      return errorResult("INVALID_RESOLVER", `expr references unknown property symbol: ${malformed.join(", ")}`);
    }
    // Enforce the sandbox whitelist (length, node budget, allowed ops/functions)
    // at save time — otherwise a bad expression persists and only surfaces as a
    // runtime quality:"bad" zombie that never recomputes.
    const syntaxErrors = validateExpression(expression);
    if (syntaxErrors.length > 0) {
      return errorResult("INVALID_RESOLVER", `expr validation failed: ${syntaxErrors.join("; ")}`);
    }
    const dependencyIds = extractExpressionDependencyIds(expression);
    const known = args.knownPropertyIds;
    const toCheck = known ? dependencyIds.filter((id) => !known.has(id)) : dependencyIds;
    const dependencyResult = await assertPropertiesInSite(toCheck, args.scope);
    if (dependencyResult && "error" in dependencyResult) return dependencyResult;
    return { data: { resolver, dependencyIds } };
  }

  if (resolverType === "window") {
    const sourcePropertyId = resolver.sourcePropertyId as string;
    // In-batch sibling sources skip the "exists in site" check (like expr
    // dependencies above); batch callers verify the planned source's resolver
    // type themselves since it isn't in the DB yet.
    if (!args.knownPropertyIds?.has(sourcePropertyId)) {
      const dependencyResult = await assertPropertiesInSite([sourcePropertyId], args.scope);
      if (dependencyResult && "error" in dependencyResult) return dependencyResult;
      const source = dependencyResult?.data[0];
      if (source?.resolverType === "window")
        return errorResult("INVALID_RESOLVER", "window source cannot be another window property");
    }
    return { data: { resolver, dependencyIds: [sourcePropertyId] } };
  }

  if (resolverType === "rollup") {
    const parentError = await validateRollupParent(resolver.parent, args.scope);
    if (parentError) return parentError;
    return { data: { resolver, dependencyIds: [] } };
  }

  return { data: { resolver, dependencyIds: [] } };
}

export async function validateAcyclicStaticEdges(args: {
  propertyId: string;
  dependencyIds: readonly string[];
}): Promise<{ success: true } | { error: string; code: string }> {
  const edges = await prisma.graphEdge.findMany({
    where: {
      fromProperty: { isDeleted: false, node: { isDeleted: false } },
      toProperty: { isDeleted: false, node: { isDeleted: false } },
      NOT: { toPropertyId: args.propertyId },
    },
    select: { fromPropertyId: true, toPropertyId: true },
  });

  const adjacency = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    const set = adjacency.get(from) ?? new Set<string>();
    set.add(to);
    adjacency.set(from, set);
    if (!adjacency.has(to)) adjacency.set(to, new Set<string>());
  };

  for (const edge of edges) addEdge(edge.fromPropertyId, edge.toPropertyId);
  for (const depId of new Set(args.dependencyIds)) addEdge(depId, args.propertyId);

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const id of adjacency.keys()) {
    if (visit(id)) return errorResult("GRAPH_CYCLE", "Graph dependency cycle detected");
  }
  return { success: true };
}

export function isRecordResolver(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
