import { randomUUID } from "node:crypto";
import prisma from "@rw/db";

import {
  getLivestoreHookEventSchema,
  normalizeLivestoreEventToken,
  normalizeLivestoreEventVersion,
} from "../catalog/events.js";
import {
  graphHookConditionPropertyIds,
  graphHookEventContextPropertyIds,
  parseGraphHookCondition,
  parseGraphHookEventContext,
} from "../catalog/hook-conditions.js";

import { graphVersion, type GraphVersion } from "./introspect.js";
import * as nodeTypes from "./node-types.js";
import { validateTypeInputs } from "./nodes.js";
import { getGraphSiteForWorkspace, graphNodeSiteWhere } from "./scope.js";
import { errorResult, type GraphScope, type ServiceResult } from "./types.js";
import { validateResolverConfig } from "./validation.js";

// Dry-run validation of a whole prospective changeset (creations only) in one
// call: an agent composes nodes + properties + hooks, gets every problem back
// at once, and only then commits via the individual create RPCs. Nothing here
// writes. Commit-time safety does not depend on this — the write path
// revalidates everything — so a plan is advisory and perishable; callers
// should re-plan if graphVersion moved before they commit.

export interface PlanNodeInput {
  // Batch-local handle so planned properties can target this node before it
  // has an id ("nodeRef"). Must be unique within the batch.
  ref: string;
  name: string;
  typeRef?: string | null;
  typeContext?: Record<string, unknown>;
  materializeTypeFields?: boolean;
}

export interface PlanPropertyInput {
  // Client-generated UUID; required when other planned items reference this
  // property (expressions, window sources, hook conditions). Assigned by the
  // planner when omitted, and honored by property.create at commit time.
  id?: string;
  // Exactly one of nodeId (existing node) or nodeRef (planned node).
  nodeId?: string;
  nodeRef?: string;
  name: string;
  resolverType: string;
  resolver: Record<string, unknown>;
  sampleRateMs?: number | null;
}

export interface PlanHookInput {
  name: string;
  enabled?: boolean;
  condition: Record<string, unknown>;
  eventNamespace: string;
  eventName: string;
  eventVersion?: string;
  eventPayload?: Record<string, unknown>;
  eventContext?: Record<string, unknown>;
}

export interface GraphPlanInput {
  nodes?: PlanNodeInput[];
  properties?: PlanPropertyInput[];
  hooks?: PlanHookInput[];
}

export interface GraphPlanIssue {
  // e.g. "nodes[0].name", "properties[2].resolver", "hooks[1].condition"
  path: string;
  code: string;
  error: string;
}

export interface GraphPlanResult {
  valid: boolean;
  graphVersion: GraphVersion;
  issues: GraphPlanIssue[];
  // Planned properties echoed with their (possibly planner-assigned) ids, in
  // input order. Commit with property.create({ id, ... }) to keep references
  // valid.
  properties: Array<{ index: number; id: string; name: string; nodeId: string | null; nodeRef: string | null }>;
  // Dependency edges the changeset would add.
  plannedEdges: Array<{ fromPropertyId: string; toPropertyId: string }>;
  notes: string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function detectCycle(plannedEdges: ReadonlyArray<{ fromPropertyId: string; toPropertyId: string }>) {
  const edges = await prisma.graphEdge.findMany({
    where: {
      fromProperty: { isDeleted: false, node: { isDeleted: false } },
      toProperty: { isDeleted: false, node: { isDeleted: false } },
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
  for (const edge of plannedEdges) addEdge(edge.fromPropertyId, edge.toPropertyId);

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
    if (visit(id)) return true;
  }
  return false;
}

export async function plan(input: GraphPlanInput, scope: GraphScope): Promise<ServiceResult<GraphPlanResult>> {
  const siteResult = await getGraphSiteForWorkspace(scope.siteId, scope.workspaceId);
  if ("error" in siteResult) return siteResult;

  const nodes = input.nodes ?? [];
  const properties = input.properties ?? [];
  const hooks = input.hooks ?? [];
  if (nodes.length === 0 && properties.length === 0 && hooks.length === 0) {
    return errorResult("EMPTY_PLAN", "Plan must contain at least one node, property, or hook");
  }

  const issues: GraphPlanIssue[] = [];
  const notes: string[] = [];
  const issue = (path: string, code: string, error: string) => issues.push({ path, code, error });

  // --- Nodes ---
  const nodeRefs = new Set<string>();
  const plannedNodeNames = new Set<string>();
  const resolvedTypeByRef = new Map<string, Awaited<ReturnType<typeof nodeTypes.resolve>> | null>();
  for (const [index, node] of nodes.entries()) {
    const path = `nodes[${index}]`;
    if (nodeRefs.has(node.ref)) issue(`${path}.ref`, "DUPLICATE_NODE_REF", `Duplicate node ref "${node.ref}"`);
    nodeRefs.add(node.ref);

    const name = node.name.trim();
    if (!name) {
      issue(`${path}.name`, "INVALID_NAME", "Graph node name is required");
    } else {
      if (plannedNodeNames.has(name))
        issue(`${path}.name`, "GRAPH_NODE_NAME_EXISTS", `Node name "${name}" appears twice in the plan`);
      plannedNodeNames.add(name);
      const conflict = await prisma.graphNode.findFirst({
        where: { siteId: scope.siteId, name, isDeleted: false },
        select: { id: true },
      });
      if (conflict) issue(`${path}.name`, "GRAPH_NODE_NAME_EXISTS", `Node name "${name}" already exists in the site`);
    }

    if (node.typeRef) {
      if (!resolvedTypeByRef.has(node.typeRef)) {
        resolvedTypeByRef.set(node.typeRef, await nodeTypes.resolve(node.typeRef, scope));
      }
      const resolved = resolvedTypeByRef.get(node.typeRef);
      if (!resolved || "error" in resolved) {
        issue(`${path}.typeRef`, resolved && "error" in resolved ? resolved.code : "GRAPH_TYPE_NOT_FOUND",
          resolved && "error" in resolved ? resolved.error : "Graph type not found");
      } else {
        const inputResult = await validateTypeInputs({
          type: resolved.data,
          typeContext: node.typeContext ?? {},
          scope,
        });
        if ("error" in inputResult) issue(`${path}.typeContext`, inputResult.code, inputResult.error);
        if (node.materializeTypeFields) {
          notes.push(
            `${path}: materialized type fields are validated and stamped at commit time; they are not part of this plan's edge/cycle analysis.`,
          );
        }
      }
    } else if (node.materializeTypeFields) {
      issue(`${path}.materializeTypeFields`, "INVALID_TYPE_REF", "materializeTypeFields requires a typeRef");
    }
  }

  // --- Properties: identity pass (ids, node targets, names) ---
  const plannedPropertyIds = new Set<string>();
  const clientIds = properties.map((p) => p.id).filter((id): id is string => Boolean(id));
  const existingIdRows = clientIds.length
    ? await prisma.graphProperty.findMany({ where: { id: { in: clientIds } }, select: { id: true } })
    : [];
  const takenIds = new Set(existingIdRows.map((row) => row.id));

  const assigned = properties.map((property, index) => {
    const path = `properties[${index}]`;
    let id = property.id;
    if (id) {
      if (!UUID_PATTERN.test(id)) {
        issue(`${path}.id`, "INVALID_PROPERTY_ID", "Planned property id must be a UUID");
        id = randomUUID();
      } else if (takenIds.has(id)) {
        issue(`${path}.id`, "GRAPH_PROPERTY_ID_CONFLICT", "Graph property id is already in use");
      } else if (plannedPropertyIds.has(id)) {
        issue(`${path}.id`, "GRAPH_PROPERTY_ID_CONFLICT", "Planned property id appears twice in the plan");
      }
    } else {
      id = randomUUID();
    }
    plannedPropertyIds.add(id);

    if ((property.nodeId ? 1 : 0) + (property.nodeRef ? 1 : 0) !== 1) {
      issue(`${path}`, "INVALID_NODE_TARGET", "Provide exactly one of nodeId or nodeRef");
    } else if (property.nodeRef && !nodeRefs.has(property.nodeRef)) {
      issue(`${path}.nodeRef`, "UNKNOWN_NODE_REF", `nodeRef "${property.nodeRef}" is not a planned node`);
    }

    return { index, id, property };
  });

  // Existing target nodes must be in the site.
  const targetNodeIds = [...new Set(properties.map((p) => p.nodeId).filter((id): id is string => Boolean(id)))];
  const targetNodes = targetNodeIds.length
    ? await prisma.graphNode.findMany({
        where: { id: { in: targetNodeIds }, ...graphNodeSiteWhere(scope) },
        select: { id: true },
      })
    : [];
  const knownNodeIds = new Set(targetNodes.map((node) => node.id));
  for (const { index, property } of assigned) {
    if (property.nodeId && !knownNodeIds.has(property.nodeId)) {
      issue(`properties[${index}].nodeId`, "GRAPH_NODE_NOT_FOUND", "Graph node not found");
    }
  }

  // Name uniqueness per target (existing node: batch + DB; planned node: batch).
  const namesByTarget = new Map<string, Set<string>>();
  for (const { index, property } of assigned) {
    const path = `properties[${index}].name`;
    const name = property.name.trim();
    if (!name) {
      issue(path, "INVALID_NAME", "Graph property name is required");
      continue;
    }
    const target = property.nodeId ? `id:${property.nodeId}` : `ref:${property.nodeRef ?? ""}`;
    const names = namesByTarget.get(target) ?? new Set<string>();
    if (names.has(name))
      issue(path, "GRAPH_PROPERTY_NAME_EXISTS", `Property name "${name}" appears twice for the same node`);
    names.add(name);
    namesByTarget.set(target, names);

    if (property.nodeId && knownNodeIds.has(property.nodeId)) {
      const conflict = await prisma.graphProperty.findUnique({
        where: { nodeId_name: { nodeId: property.nodeId, name } },
        select: { isDeleted: true },
      });
      if (conflict && !conflict.isDeleted)
        issue(path, "GRAPH_PROPERTY_NAME_EXISTS", "Graph property name already exists on this node");
    }
  }

  const sampleRateInvalid = (value: number | null | undefined) =>
    value !== null && value !== undefined && (!Number.isInteger(value) || value <= 0);

  // --- Properties: resolver pass ---
  const resolverTypeById = new Map<string, string>();
  for (const { id, property } of assigned) resolverTypeById.set(id, property.resolverType);

  const plannedEdges: GraphPlanResult["plannedEdges"] = [];
  for (const { index, id, property } of assigned) {
    const path = `properties[${index}]`;
    if (sampleRateInvalid(property.sampleRateMs))
      issue(`${path}.sampleRateMs`, "INVALID_SAMPLE_RATE", "sampleRateMs must be a positive integer");

    const resolverResult = await validateResolverConfig({
      resolverType: property.resolverType,
      resolver: property.resolver,
      scope,
      knownPropertyIds: plannedPropertyIds,
    });
    if ("error" in resolverResult) {
      issue(`${path}.resolver`, resolverResult.code, resolverResult.error);
      continue;
    }

    // validateResolverConfig skips in-batch window sources (they aren't in
    // the DB), so enforce the window-over-window rule against the batch here.
    const config = resolverResult.data.resolver;
    if (
      property.resolverType === "window" &&
      typeof config.sourcePropertyId === "string" &&
      plannedPropertyIds.has(config.sourcePropertyId) &&
      resolverTypeById.get(config.sourcePropertyId) === "window"
    ) {
      issue(`${path}.resolver`, "INVALID_RESOLVER", "window source cannot be another window property");
      continue;
    }

    for (const dependencyId of new Set(resolverResult.data.dependencyIds)) {
      plannedEdges.push({ fromPropertyId: dependencyId, toPropertyId: id });
    }
  }

  // --- Cycle check over existing + planned edges ---
  if (plannedEdges.length > 0 && (await detectCycle(plannedEdges))) {
    issue("properties", "GRAPH_CYCLE", "Graph dependency cycle detected");
  }

  // --- Hooks ---
  const referencedIds = new Set<string>();
  const plannedHookNames = new Set<string>();
  const hookChecks = hooks.map((hook, index) => {
    const path = `hooks[${index}]`;
    const name = hook.name.trim();
    if (!name) issue(`${path}.name`, "INVALID_NAME", "Graph hook name is required");
    if (name) {
      if (plannedHookNames.has(name))
        issue(`${path}.name`, "GRAPH_HOOK_NAME_EXISTS", `Hook name "${name}" appears twice in the plan`);
      plannedHookNames.add(name);
    }

    const condition = parseGraphHookCondition(hook.condition);
    if (!condition) {
      issue(`${path}.condition`, "INVALID_HOOK_CONDITION", "Graph hook condition is invalid");
    } else {
      for (const propertyId of graphHookConditionPropertyIds(condition)) referencedIds.add(propertyId);
    }

    const context = parseGraphHookEventContext(hook.eventContext);
    if (context === null) {
      issue(`${path}.eventContext`, "INVALID_HOOK_CONTEXT", "Graph hook event context is invalid");
    } else {
      for (const propertyId of graphHookEventContextPropertyIds(context)) referencedIds.add(propertyId);
    }

    try {
      const namespace = normalizeLivestoreEventToken(hook.eventNamespace);
      const eventName = normalizeLivestoreEventToken(hook.eventName);
      const version = normalizeLivestoreEventVersion(hook.eventVersion ?? "1");
      if (!getLivestoreHookEventSchema(namespace, eventName, version)) {
        issue(`${path}.event`, "UNKNOWN_HOOK_EVENT", `Unknown hook event ${namespace}.${eventName} v${version}`);
      }
    } catch (err) {
      issue(`${path}.event`, "INVALID_HOOK_EVENT", err instanceof Error ? err.message : "Graph hook event is invalid");
    }

    return { index, name, condition, context };
  });

  for (const { index, name } of hookChecks) {
    if (!name) continue;
    const conflict = await prisma.graphHook.findFirst({
      where: { siteId: scope.siteId, name, isDeleted: false },
      select: { id: true },
    });
    if (conflict)
      issue(`hooks[${index}].name`, "GRAPH_HOOK_NAME_EXISTS", "Graph hook name already exists in the site");
  }

  // Hook property references: planned ids or existing site properties.
  const unknownRefs = [...referencedIds].filter((id) => !plannedPropertyIds.has(id));
  if (unknownRefs.length > 0) {
    const found = await prisma.graphProperty.findMany({
      where: { id: { in: unknownRefs }, isDeleted: false, node: graphNodeSiteWhere(scope) },
      select: { id: true },
    });
    const foundIds = new Set(found.map((row) => row.id));
    for (const missing of unknownRefs.filter((id) => !foundIds.has(id))) {
      issue("hooks", "HOOK_PROPERTY_NOT_FOUND", `Hook references unknown property ${missing}`);
    }
  }

  const version = await graphVersion(scope);
  return {
    data: {
      valid: issues.length === 0,
      graphVersion: version,
      issues,
      properties: assigned.map(({ index, id, property }) => ({
        index,
        id,
        name: property.name,
        nodeId: property.nodeId ?? null,
        nodeRef: property.nodeRef ?? null,
      })),
      plannedEdges,
      notes,
    },
  };
}
