import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import { publishGraphDefinitionEvent } from "./definition-events.js";
import * as hooks from "./hooks.js";
import type { GraphVersion } from "./introspect.js";
import * as nodes from "./nodes.js";
import { plan, type GraphPlanInput, type GraphPlanResult } from "./plan.js";
import * as properties from "./properties.js";
import { errorResult, type GraphScope } from "./types.js";

// A changeset is a proposed batch of graph creations. Whoever proposes it (a
// person or the Console agent) gets the planner's issues back immediately; a
// person reviews the stored spec and applies it, and apply writes every item
// in one transaction. The planner is advisory, so apply re-plans first and
// refuses when the graph moved since the plan the reviewer saw.

export type GraphChangesetStatus = "DRAFT" | "APPLIED" | "DISCARDED";
export type GraphChangesetAuthor = "USER" | "AGENT";

export interface CreateGraphChangesetInput {
  title: string;
  rationale?: string | null;
  spec: GraphPlanInput;
  author?: GraphChangesetAuthor;
  sessionId?: string | null;
  createdById?: string | null;
}

export interface GraphChangesetAppliedResult {
  nodes: Record<string, string>;
  properties: string[];
  hooks: string[];
}

export interface ApplyGraphChangesetOptions {
  // The graphVersion the reviewer approved; apply refuses with
  // GRAPH_CHANGESET_STALE when the fresh plan's version differs.
  expectedGraphVersion?: GraphVersion | null;
  appliedById?: string | null;
}

const changesetSelect = {
  id: true,
  siteId: true,
  title: true,
  rationale: true,
  status: true,
  author: true,
  spec: true,
  planResult: true,
  graphVersion: true,
  sessionId: true,
  createdById: true,
  appliedById: true,
  appliedAt: true,
  appliedResult: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function sameGraphVersion(a: GraphVersion | null | undefined, b: GraphVersion | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.asOf === b.asOf &&
    a.counts.nodes === b.counts.nodes &&
    a.counts.properties === b.counts.properties &&
    a.counts.edges === b.counts.edges &&
    a.counts.hooks === b.counts.hooks &&
    a.counts.types === b.counts.types
  );
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// The planner assigns ids to properties that came without one. Stamp them
// back into the spec so the reviewed ids are the ids that get written, and so
// hooks proposed later in the conversation can reference them.
function stampPlannedIds(spec: GraphPlanInput, result: GraphPlanResult): GraphPlanInput {
  if (!spec.properties?.length) return spec;
  const idByIndex = new Map(result.properties.map((p) => [p.index, p.id]));
  return {
    ...spec,
    properties: spec.properties.map((property, index) => ({ ...property, id: property.id ?? idByIndex.get(index) })),
  };
}

async function getForSite(id: string, scope: GraphScope) {
  const changeset = await prisma.graphChangeset.findUnique({
    where: { id },
    select: { ...changesetSelect, site: { select: { workspaceId: true } } },
  });
  if (!changeset || changeset.siteId !== scope.siteId || changeset.site.workspaceId !== scope.workspaceId) {
    return null;
  }
  const { site: _site, ...rest } = changeset;
  return rest;
}

export async function create(input: CreateGraphChangesetInput, scope: GraphScope) {
  const title = input.title.trim();
  if (!title) return errorResult("INVALID_TITLE", "Changeset title is required");

  const planned = await plan(input.spec, scope);
  if ("error" in planned) return planned;

  const spec = stampPlannedIds(input.spec, planned.data);
  const changeset = await prisma.graphChangeset.create({
    data: {
      siteId: scope.siteId,
      title,
      rationale: input.rationale?.trim() || null,
      author: input.author ?? "USER",
      spec: asJson(spec),
      planResult: asJson(planned.data),
      graphVersion: asJson(planned.data.graphVersion),
      sessionId: input.sessionId ?? null,
      createdById: input.createdById ?? null,
    },
    select: changesetSelect,
  });
  return { data: changeset };
}

export async function get(id: string, scope: GraphScope) {
  const changeset = await getForSite(id, scope);
  if (!changeset) return errorResult("GRAPH_CHANGESET_NOT_FOUND", "Changeset not found");
  return { data: changeset };
}

export async function list(
  filter: { status?: GraphChangesetStatus; sessionId?: string; limit?: number },
  scope: GraphScope,
) {
  const rows = await prisma.graphChangeset.findMany({
    where: {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
    select: changesetSelect,
  });
  return { data: rows };
}

export async function replan(id: string, scope: GraphScope) {
  const current = await getForSite(id, scope);
  if (!current) return errorResult("GRAPH_CHANGESET_NOT_FOUND", "Changeset not found");
  if (current.status !== "DRAFT") return errorResult("GRAPH_CHANGESET_CLOSED", "Changeset is no longer a draft");

  const planned = await plan(current.spec as GraphPlanInput, scope);
  if ("error" in planned) return planned;

  const changeset = await prisma.graphChangeset.update({
    where: { id },
    data: { planResult: asJson(planned.data), graphVersion: asJson(planned.data.graphVersion) },
    select: changesetSelect,
  });
  return { data: changeset };
}

export async function discard(id: string, scope: GraphScope) {
  const current = await getForSite(id, scope);
  if (!current) return errorResult("GRAPH_CHANGESET_NOT_FOUND", "Changeset not found");
  if (current.status !== "DRAFT") return errorResult("GRAPH_CHANGESET_CLOSED", "Changeset is no longer a draft");

  const changeset = await prisma.graphChangeset.update({
    where: { id },
    data: { status: "DISCARDED" },
    select: changesetSelect,
  });
  return { data: changeset };
}

function failAt(path: string, result: { error: string; code: string }) {
  return errorResult(result.code, `${path}: ${result.error}`);
}

export async function apply(id: string, scope: GraphScope, options: ApplyGraphChangesetOptions = {}) {
  const current = await getForSite(id, scope);
  if (!current) return errorResult("GRAPH_CHANGESET_NOT_FOUND", "Changeset not found");
  if (current.status !== "DRAFT") return errorResult("GRAPH_CHANGESET_CLOSED", "Changeset is no longer a draft");

  const spec = current.spec as GraphPlanInput;
  const planned = await plan(spec, scope);
  if ("error" in planned) return planned;

  // Keep the stored plan current whatever happens next, so the reviewer sees
  // why apply refused.
  const refreshPlan = () =>
    prisma.graphChangeset.update({
      where: { id },
      data: { planResult: asJson(planned.data), graphVersion: asJson(planned.data.graphVersion) },
    });

  const approvedVersion = options.expectedGraphVersion ?? (current.graphVersion as unknown as GraphVersion);
  if (!sameGraphVersion(approvedVersion, planned.data.graphVersion)) {
    await refreshPlan();
    return errorResult("GRAPH_CHANGESET_STALE", "The graph changed since this changeset was reviewed; review it again");
  }
  if (!planned.data.valid) {
    await refreshPlan();
    return errorResult("GRAPH_CHANGESET_INVALID", planned.data.issues[0]?.error ?? "Changeset has plan issues");
  }

  // Prepare every item against the batch context, then write them all at once.
  const plannedPropertyIds = new Set(planned.data.properties.map((p) => p.id));

  const preparedNodes: Array<{ ref: string; prepared: nodes.PreparedGraphNodeCreate }> = [];
  for (const [index, node] of (spec.nodes ?? []).entries()) {
    const result = await nodes.prepareCreate(node, scope);
    if ("error" in result) return failAt(`nodes[${index}]`, result);
    preparedNodes.push({ ref: node.ref, prepared: result.data });
  }
  const nodeIdByRef = new Map(preparedNodes.map(({ ref, prepared }) => [ref, prepared.nodeId]));
  const plannedNodeIds = new Set(nodeIdByRef.values());

  const preparedProperties: properties.PreparedGraphPropertyCreate[] = [];
  for (const [index, property] of (spec.properties ?? []).entries()) {
    const nodeId = property.nodeId ?? nodeIdByRef.get(property.nodeRef ?? "");
    if (!nodeId) return errorResult("UNKNOWN_NODE_REF", `properties[${index}]: unknown nodeRef`);
    const result = await properties.prepareCreate(
      {
        id: planned.data.properties[index]?.id ?? property.id,
        nodeId,
        name: property.name,
        resolverType: property.resolverType,
        resolver: property.resolver,
        sampleRateMs: property.sampleRateMs,
      },
      scope,
      { plannedNodeIds, knownPropertyIds: plannedPropertyIds },
    );
    if ("error" in result) return failAt(`properties[${index}]`, result);
    preparedProperties.push(result.data);
  }

  const preparedHooks: hooks.PreparedGraphHookCreate[] = [];
  for (const [index, hook] of (spec.hooks ?? []).entries()) {
    const result = await hooks.prepareCreate(hook, scope, { knownPropertyIds: plannedPropertyIds });
    if ("error" in result) return failAt(`hooks[${index}]`, result);
    preparedHooks.push(result.data);
  }

  const applied = await prisma.$transaction(async (tx) => {
    const nodeIds: Record<string, string> = {};
    for (const { ref, prepared } of preparedNodes) {
      const node = await nodes.writeCreate(tx, prepared, scope);
      nodeIds[ref] = node.id;
    }
    // Every property row before any edge: edges may point at in-batch siblings.
    for (const prepared of preparedProperties) await properties.writeCreateRow(tx, prepared);
    for (const prepared of preparedProperties) await properties.writeCreateEdges(tx, prepared);
    const hookIds: string[] = [];
    for (const prepared of preparedHooks) {
      const hook = await hooks.writeCreate(tx, prepared);
      hookIds.push(hook.id);
    }

    const appliedResult: GraphChangesetAppliedResult = {
      nodes: nodeIds,
      properties: preparedProperties.map((p) => p.propertyId),
      hooks: hookIds,
    };
    const changeset = await tx.graphChangeset.update({
      where: { id },
      data: {
        status: "APPLIED",
        appliedById: options.appliedById ?? null,
        appliedAt: new Date(),
        appliedResult: asJson(appliedResult),
        planResult: asJson(planned.data),
        graphVersion: asJson(planned.data.graphVersion),
      },
      select: changesetSelect,
    });
    return { changeset, appliedResult };
  });

  // Definition events only after commit, so livestore never loads a
  // half-written batch.
  for (const nodeId of Object.values(applied.appliedResult.nodes)) {
    publishGraphDefinitionEvent({ entity: "node", action: "created", entityId: nodeId, siteId: scope.siteId });
  }
  for (const prepared of preparedProperties) {
    publishGraphDefinitionEvent({
      entity: "property",
      action: "created",
      entityId: prepared.propertyId,
      nodeId: prepared.nodeId,
      siteId: scope.siteId,
    });
  }
  for (const hookId of applied.appliedResult.hooks) {
    publishGraphDefinitionEvent({ entity: "hook", action: "created", entityId: hookId, siteId: scope.siteId });
  }

  return { data: applied.changeset };
}
