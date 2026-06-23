import prisma from "@rw/db";

import { graphNodeSiteWhere } from "./scope.js";
import { errorResult, type GraphScope } from "./types.js";

const AGGREGATIONS = new Set(["sum", "avg", "count", "min", "max"]);
const PREFIXED_UUID_PATTERN = /\bp_([0-9a-f]{8}_[0-9a-f]{4}_[1-8][0-9a-f]{3}_[89ab][0-9a-f]{3}_[0-9a-f]{12})\b/gi;

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
}): Promise<
  { data: { resolver: Record<string, unknown>; dependencyIds: string[] } } | { error: string; code: string }
> {
  const resolverType = args.resolverType.trim();
  const resolver: Record<string, unknown> & { type: string } = {
    ...args.resolver,
    type: typeof args.resolver.type === "string" ? args.resolver.type : resolverType,
  };
  if (resolver.type !== resolverType)
    return errorResult("RESOLVER_TYPE_MISMATCH", "resolver.type must match resolverType");

  if (resolverType === "tag") {
    if (typeof resolver.deviceId !== "string" || typeof resolver.tagPath !== "string") {
      return errorResult("INVALID_RESOLVER", "tag resolver requires deviceId and tagPath");
    }
    return { data: { resolver, dependencyIds: [] } };
  }

  if (resolverType === "metric") {
    if (
      typeof resolver.entityType !== "string" ||
      typeof resolver.entityId !== "string" ||
      typeof resolver.granularity !== "string" ||
      typeof resolver.metricKey !== "string"
    ) {
      return errorResult(
        "INVALID_RESOLVER",
        "metric resolver requires entityType, entityId, granularity, and metricKey",
      );
    }
    const entityError = await assertKnownEntityInSite(resolver.entityType, resolver.entityId, args.scope);
    if (entityError) return entityError;
    return { data: { resolver, dependencyIds: [] } };
  }

  if (resolverType === "entity") {
    if (
      typeof resolver.entityType !== "string" ||
      typeof resolver.entityId !== "string" ||
      typeof resolver.path !== "string"
    ) {
      return errorResult("INVALID_RESOLVER", "entity resolver requires entityType, entityId, and path");
    }
    const entityError = await assertKnownEntityInSite(resolver.entityType, resolver.entityId, args.scope);
    if (entityError) return entityError;
    return { data: { resolver, dependencyIds: [] } };
  }

  if (resolverType === "expr") {
    if (typeof resolver.expression !== "string" || !resolver.expression.trim()) {
      return errorResult("INVALID_RESOLVER", "expr resolver requires expression");
    }
    const dependencyIds = extractExpressionDependencyIds(resolver.expression);
    const dependencyResult = await assertPropertiesInSite(dependencyIds, args.scope);
    if (dependencyResult && "error" in dependencyResult) return dependencyResult;
    return { data: { resolver, dependencyIds } };
  }

  if (resolverType === "window") {
    if (typeof resolver.sourcePropertyId !== "string")
      return errorResult("INVALID_RESOLVER", "window resolver requires sourcePropertyId");
    const dependencyResult = await assertPropertiesInSite([resolver.sourcePropertyId], args.scope);
    if (dependencyResult && "error" in dependencyResult) return dependencyResult;
    const source = dependencyResult?.data[0];
    if (source?.resolverType === "window")
      return errorResult("INVALID_RESOLVER", "window source cannot be another window property");
    if (resolver.kind !== "tumbling" && resolver.kind !== "ewma")
      return errorResult("INVALID_RESOLVER", "window kind must be tumbling or ewma");
    if (resolver.kind === "tumbling") {
      if (typeof resolver.windowMs !== "number" || !Number.isFinite(resolver.windowMs) || resolver.windowMs < 1000) {
        return errorResult("INVALID_RESOLVER", "tumbling windowMs must be a finite number >= 1000");
      }
      if (typeof resolver.aggregation !== "string" || !AGGREGATIONS.has(resolver.aggregation)) {
        return errorResult("INVALID_RESOLVER", "tumbling aggregation must be one of sum, avg, count, min, max");
      }
    } else if (typeof resolver.alpha !== "number" || !(resolver.alpha > 0 && resolver.alpha <= 1)) {
      return errorResult("INVALID_RESOLVER", "ewma alpha must be a number in (0, 1]");
    }
    return { data: { resolver, dependencyIds: [resolver.sourcePropertyId] } };
  }

  if (resolverType === "rollup") {
    if (
      typeof resolver.childKind !== "string" ||
      typeof resolver.relation !== "string" ||
      typeof resolver.childProperty !== "string" ||
      typeof resolver.aggregation !== "string" ||
      !AGGREGATIONS.has(resolver.aggregation)
    ) {
      return errorResult(
        "INVALID_RESOLVER",
        "rollup resolver requires childKind, relation, childProperty, and aggregation",
      );
    }
    const parentError = await validateRollupParent(resolver.parent, args.scope);
    if (parentError) return parentError;
    return { data: { resolver, dependencyIds: [] } };
  }

  return errorResult("INVALID_RESOLVER_TYPE", `Unsupported resolverType "${resolverType}"`);
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
