import prisma from "@rw/db";

import type { GraphTypeInputValueType, GraphTypeValueType } from "../catalog/graph-types.js";
import {
  graphHookConditionPropertyIds,
  graphHookEventContextPropertyIds,
  parseGraphHookCondition,
  parseGraphHookEventContext,
} from "../catalog/hook-conditions.js";

import * as nodeTypes from "./node-types.js";
import { getGraphPropertyForSite, graphNodeSiteWhere } from "./scope.js";
import { errorResult, type GraphScope, type ServiceResult } from "./types.js";

// Introspection service layer: read-only views compiled for programmatic
// builders. Everything here reads Postgres/catalog state only — no engine
// involvement.

type JsonSchema = Record<string, unknown>;

function valueTypeToJsonSchema(
  valueType: GraphTypeValueType | GraphTypeInputValueType,
  entityKey?: string | null,
): JsonSchema {
  switch (valueType) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "percent":
      return { type: "number", description: "Ratio expressed as a number (1 = 100%)." };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "object":
    case "json":
      return {};
    case "entityRef":
      return {
        type: "string",
        description: entityKey
          ? `ID of a "${entityKey}" entity instance in the site (see entity.catalog / entity list RPCs).`
          : "ID of an entity instance in the site.",
        ...(entityKey ? { "x-entityKey": entityKey } : {}),
      };
    default:
      return {};
  }
}

export interface GraphTypeNodeSchema {
  typeRef: string;
  source: "integration" | "site";
  label: string;
  description: string | null;
  // JSON Schema for the graph.node.create payload targeting this type.
  nodeCreateSchema: JsonSchema;
  // Properties stamped onto the node when materializeTypeFields is true.
  materializedFields: Array<{
    key: string;
    label: string;
    description: string | null;
    valueType: GraphTypeValueType;
    resolverType: string;
    sampleRateMs: number | null;
  }>;
  // Entity-derived facets computed for the node (queryable via node.query).
  facets: Array<{
    key: string;
    label: string;
    description: string | null;
    valueType: GraphTypeValueType | null;
  }>;
}

// Compile a graph type (integration or site-defined) into a JSON Schema an
// agent can use to construct a valid node.create call. Generated on request
// because site types are user data and change at runtime.
export async function typeNodeSchema(typeRef: string, scope: GraphScope): Promise<ServiceResult<GraphTypeNodeSchema>> {
  const resolved = await nodeTypes.resolve(typeRef, scope);
  if ("error" in resolved) return resolved;
  const type = resolved.data;

  const contextProperties: Record<string, JsonSchema> = {};
  const requiredInputs: string[] = [];
  for (const input of type.inputs) {
    contextProperties[input.key] = {
      ...valueTypeToJsonSchema(input.valueType, input.entityKey),
      ...(input.description ? { description: input.description } : {}),
      title: input.label,
    };
    if (input.required) requiredInputs.push(input.key);
  }

  const nodeCreateSchema: JsonSchema = {
    type: "object",
    description: `Payload for graph.node.create with typeRef "${type.typeRef}".`,
    properties: {
      siteId: { type: "string", format: "uuid" },
      name: { type: "string", minLength: 1, description: "Unique node name within the site." },
      typeRef: { const: type.typeRef },
      typeContext: {
        type: "object",
        description: "Values for the type's declared inputs.",
        properties: contextProperties,
        ...(requiredInputs.length > 0 ? { required: requiredInputs } : {}),
      },
      materializeTypeFields: {
        type: "boolean",
        description: "When true, the type's fields are stamped onto the node as properties at create time.",
      },
    },
    required: ["siteId", "name", "typeRef", ...(requiredInputs.length > 0 ? ["typeContext"] : [])],
  };

  return {
    data: {
      typeRef: type.typeRef,
      source: type.source,
      label: type.label,
      description: type.description ?? null,
      nodeCreateSchema,
      materializedFields: type.fields.map((field) => ({
        key: field.key,
        label: field.label,
        description: field.description ?? null,
        valueType: field.valueType,
        resolverType: field.resolverType,
        sampleRateMs: field.sampleRateMs ?? null,
      })),
      facets: type.facets.map((facet) => ({
        key: facet.key,
        label: facet.label,
        description: facet.description ?? null,
        valueType: facet.valueType ?? null,
      })),
    },
  };
}

// A monotonic freshness stamp for the site's graph. Soft deletes bump
// updatedAt, and edge changes always ride a property save, so the max
// updatedAt across definition tables moves on every definition change.
// Deleted rows are deliberately included: a delete IS a change.
export interface GraphVersion {
  asOf: string | null;
  counts: { nodes: number; properties: number; edges: number; hooks: number; types: number };
}

export async function graphVersion(scope: GraphScope): Promise<GraphVersion> {
  const siteWhere = { siteId: scope.siteId, site: { workspaceId: scope.workspaceId } };
  const propertyWhere = { node: { siteId: scope.siteId, site: { workspaceId: scope.workspaceId } } };
  const typeWhere = { type: siteWhere };

  const [node, property, hook, nodeType, typeInput, typeFacet, typeField, counts] = await Promise.all([
    prisma.graphNode.aggregate({ where: siteWhere, _max: { updatedAt: true } }),
    prisma.graphProperty.aggregate({ where: propertyWhere, _max: { updatedAt: true } }),
    prisma.graphHook.aggregate({ where: siteWhere, _max: { updatedAt: true } }),
    prisma.graphNodeType.aggregate({ where: siteWhere, _max: { updatedAt: true } }),
    prisma.graphNodeTypeInput.aggregate({ where: typeWhere, _max: { updatedAt: true } }),
    prisma.graphNodeTypeFacet.aggregate({ where: typeWhere, _max: { updatedAt: true } }),
    prisma.graphNodeTypeField.aggregate({ where: typeWhere, _max: { updatedAt: true } }),
    Promise.all([
      prisma.graphNode.count({ where: graphNodeSiteWhere(scope) }),
      prisma.graphProperty.count({ where: { isDeleted: false, node: graphNodeSiteWhere(scope) } }),
      prisma.graphEdge.count({
        where: { toProperty: { isDeleted: false, node: graphNodeSiteWhere(scope) } },
      }),
      prisma.graphHook.count({ where: { ...graphNodeSiteWhere(scope) } }),
      prisma.graphNodeType.count({ where: { ...graphNodeSiteWhere(scope) } }),
    ]),
  ]);

  const stamps = [node, property, hook, nodeType, typeInput, typeFacet, typeField]
    .map((result) => result._max.updatedAt)
    .filter((stamp): stamp is Date => stamp instanceof Date);
  const asOf = stamps.length > 0 ? new Date(Math.max(...stamps.map((s) => s.getTime()))).toISOString() : null;

  const [nodes, properties, edges, hooks, types] = counts;
  return { asOf, counts: { nodes, properties, edges, hooks, types } };
}

export interface GraphIntrospectionSnapshot {
  graphVersion: GraphVersion;
  nodes: Array<{
    id: string;
    name: string;
    typeRef: string | null;
    typeContext: unknown;
    facets: unknown;
  }>;
  properties: Array<{
    id: string;
    nodeId: string;
    name: string;
    typeFieldKey: string | null;
    resolverType: string;
    resolver: unknown;
    sampleRateMs: number | null;
  }>;
  edges: Array<{ fromPropertyId: string; toPropertyId: string }>;
  hooks: Array<{
    id: string;
    name: string;
    enabled: boolean;
    condition: unknown;
    eventNamespace: string;
    eventName: string;
    eventVersion: string;
  }>;
}

// The whole site graph in one call: what the paginated list RPCs return
// piecemeal, plus dependency edges, stamped with a freshness version.
export async function snapshot(scope: GraphScope): Promise<ServiceResult<GraphIntrospectionSnapshot>> {
  const nodeWhere = graphNodeSiteWhere(scope);
  const [version, nodes, properties, edges, hooks] = await Promise.all([
    graphVersion(scope),
    prisma.graphNode.findMany({
      where: nodeWhere,
      select: { id: true, name: true, typeRef: true, typeContext: true, facets: true },
      orderBy: { name: "asc" },
    }),
    prisma.graphProperty.findMany({
      where: { isDeleted: false, node: nodeWhere },
      select: {
        id: true,
        nodeId: true,
        name: true,
        typeFieldKey: true,
        resolverType: true,
        resolver: true,
        sampleRateMs: true,
      },
      orderBy: [{ nodeId: "asc" }, { name: "asc" }],
    }),
    prisma.graphEdge.findMany({
      where: { toProperty: { isDeleted: false, node: nodeWhere }, fromProperty: { isDeleted: false } },
      select: { fromPropertyId: true, toPropertyId: true },
    }),
    prisma.graphHook.findMany({
      where: nodeWhere,
      select: {
        id: true,
        name: true,
        enabled: true,
        condition: true,
        eventNamespace: true,
        eventName: true,
        eventVersion: true,
      },
      orderBy: { name: "asc" },
    }),
  ]);

  return { data: { graphVersion: version, nodes, properties, edges, hooks } };
}

// Site-scope filter for a bulk value read: returns only the requested
// properties that exist (non-deleted) in the caller's site. The RPC layer
// attaches envelopes from the CVG KV bucket.
export async function verifiedSiteProperties(
  propertyIds: readonly string[],
  scope: GraphScope,
): Promise<Array<{ id: string; nodeId: string; name: string; resolverType: string }>> {
  const uniqueIds = [...new Set(propertyIds)];
  if (uniqueIds.length === 0) return [];
  return prisma.graphProperty.findMany({
    where: { id: { in: uniqueIds }, isDeleted: false, node: graphNodeSiteWhere(scope) },
    select: { id: true, nodeId: true, name: true, resolverType: true },
  });
}

export interface ExplainNeighbor {
  propertyId: string;
  name: string;
  nodeId: string;
  nodeName: string;
  resolverType: string;
  // 1 = direct dependency/dependent, 2 = one hop further, ...
  depth: number;
}

export interface GraphPropertyExplanation {
  graphVersion: GraphVersion;
  property: {
    id: string;
    name: string;
    typeFieldKey: string | null;
    resolverType: string;
    resolver: unknown;
    sampleRateMs: number | null;
    node: { id: string; name: string; typeRef: string | null };
  };
  // Transitive closure over dependency edges, nearest first.
  upstream: ExplainNeighbor[];
  downstream: ExplainNeighbor[];
  watchingHooks: Array<{ id: string; name: string; enabled: boolean; role: "condition" | "context" }>;
}

function walkEdges(start: string, adjacency: Map<string, string[]>): Map<string, number> {
  const depths = new Map<string, number>();
  let frontier = [start];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (neighbor === start || depths.has(neighbor)) continue;
        depths.set(neighbor, depth);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return depths;
}

// Everything known about one property: config, transitive dependencies and
// dependents (with node context), and the hooks watching it. Current value
// comes from the KV bucket and is attached by the RPC layer.
export async function explain(propertyId: string, scope: GraphScope): Promise<ServiceResult<GraphPropertyExplanation>> {
  const propertyResult = await getGraphPropertyForSite(propertyId, scope);
  if (!propertyResult) return errorResult("GRAPH_PROPERTY_NOT_FOUND", "Graph property not found");
  if ("error" in propertyResult) return propertyResult;
  const property = propertyResult.data;

  const nodeWhere = graphNodeSiteWhere(scope);
  const [version, edges, siteProperties, hooks] = await Promise.all([
    graphVersion(scope),
    prisma.graphEdge.findMany({
      where: { toProperty: { isDeleted: false, node: nodeWhere }, fromProperty: { isDeleted: false } },
      select: { fromPropertyId: true, toPropertyId: true },
    }),
    prisma.graphProperty.findMany({
      where: { isDeleted: false, node: nodeWhere },
      select: { id: true, name: true, nodeId: true, resolverType: true, node: { select: { name: true } } },
    }),
    prisma.graphHook.findMany({
      where: nodeWhere,
      select: { id: true, name: true, enabled: true, condition: true, eventContext: true },
    }),
  ]);

  const upstreamAdj = new Map<string, string[]>();
  const downstreamAdj = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const edge of edges) {
    push(upstreamAdj, edge.toPropertyId, edge.fromPropertyId);
    push(downstreamAdj, edge.fromPropertyId, edge.toPropertyId);
  }

  const propertyById = new Map(siteProperties.map((p) => [p.id, p]));
  const toNeighbors = (depths: Map<string, number>): ExplainNeighbor[] =>
    [...depths.entries()]
      .flatMap(([id, depth]) => {
        const info = propertyById.get(id);
        return info
          ? [
              {
                propertyId: id,
                name: info.name,
                nodeId: info.nodeId,
                nodeName: info.node.name,
                resolverType: info.resolverType,
                depth,
              },
            ]
          : [];
      })
      .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));

  const watchingHooks: GraphPropertyExplanation["watchingHooks"] = [];
  for (const hook of hooks) {
    const condition = parseGraphHookCondition(hook.condition);
    if (condition && graphHookConditionPropertyIds(condition).includes(propertyId)) {
      watchingHooks.push({ id: hook.id, name: hook.name, enabled: hook.enabled, role: "condition" });
      continue;
    }
    const context = parseGraphHookEventContext(hook.eventContext);
    if (context && graphHookEventContextPropertyIds(context).includes(propertyId)) {
      watchingHooks.push({ id: hook.id, name: hook.name, enabled: hook.enabled, role: "context" });
    }
  }

  return {
    data: {
      graphVersion: version,
      property: {
        id: property.id,
        name: property.name,
        typeFieldKey: property.typeFieldKey,
        resolverType: property.resolverType,
        resolver: property.resolver,
        sampleRateMs: property.sampleRateMs,
        node: { id: property.node.id, name: property.node.name, typeRef: property.node.typeRef },
      },
      upstream: toNeighbors(walkEdges(propertyId, upstreamAdj)),
      downstream: toNeighbors(walkEdges(propertyId, downstreamAdj)),
      watchingHooks,
    },
  };
}

export interface GraphTypeConformanceReport {
  graphVersion: GraphVersion;
  // Nodes whose materialized properties diverge from their type's current
  // field set. Empty means every typed node matches its type.
  drift: Array<{
    nodeId: string;
    nodeName: string;
    typeRef: string;
    // Type fields with no property materialized on the node.
    missingFields: string[];
    // Node properties bound (via typeFieldKey) to fields the type no longer has.
    orphanedProperties: Array<{ propertyId: string; name: string; typeFieldKey: string }>;
  }>;
  unknownTypeRefs: Array<{ typeRef: string; nodeIds: string[] }>;
}

// Type drift report: types are user-editable and materialization is
// create-time only, so a field added to a type after nodes were created
// leaves those nodes without the property (breaking the "every node of a
// kind has the same properties" guarantee rollups rely on).
export async function conformance(scope: GraphScope): Promise<ServiceResult<GraphTypeConformanceReport>> {
  const [version, typedNodes] = await Promise.all([
    graphVersion(scope),
    prisma.graphNode.findMany({
      where: { ...graphNodeSiteWhere(scope), typeRef: { not: null } },
      select: {
        id: true,
        name: true,
        typeRef: true,
        properties: { where: { isDeleted: false }, select: { id: true, name: true, typeFieldKey: true } },
      },
      orderBy: { name: "asc" },
    }),
  ]);

  const fieldKeysByTypeRef = new Map<string, Set<string> | null>();
  const drift: GraphTypeConformanceReport["drift"] = [];
  const unknownNodesByTypeRef = new Map<string, string[]>();

  for (const node of typedNodes) {
    const typeRef = node.typeRef as string;
    if (!fieldKeysByTypeRef.has(typeRef)) {
      const resolved = await nodeTypes.resolve(typeRef, scope);
      fieldKeysByTypeRef.set(typeRef, "error" in resolved ? null : new Set(resolved.data.fields.map((f) => f.key)));
    }
    const fieldKeys = fieldKeysByTypeRef.get(typeRef) ?? null;
    if (fieldKeys === null) {
      const nodes = unknownNodesByTypeRef.get(typeRef) ?? [];
      nodes.push(node.id);
      unknownNodesByTypeRef.set(typeRef, nodes);
      continue;
    }

    const boundKeys = new Set(node.properties.map((p) => p.typeFieldKey).filter((key): key is string => key !== null));
    const missingFields = [...fieldKeys].filter((key) => !boundKeys.has(key));
    const orphanedProperties = node.properties
      .filter(
        (p): p is typeof p & { typeFieldKey: string } => p.typeFieldKey !== null && !fieldKeys.has(p.typeFieldKey),
      )
      .map((p) => ({ propertyId: p.id, name: p.name, typeFieldKey: p.typeFieldKey }));

    if (missingFields.length > 0 || orphanedProperties.length > 0) {
      drift.push({ nodeId: node.id, nodeName: node.name, typeRef, missingFields, orphanedProperties });
    }
  }

  return {
    data: {
      graphVersion: version,
      drift,
      unknownTypeRefs: [...unknownNodesByTypeRef.entries()].map(([typeRef, nodeIds]) => ({ typeRef, nodeIds })),
    },
  };
}
