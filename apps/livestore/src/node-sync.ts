import type { PrismaClient } from "@rw/db";

import { DEFAULT_KINDS } from "./entityCatalog.js";
import { prefixPropertyId } from "./expr.js";
import { additiveFields, metricPropertyName, type MetricField, ratioFields } from "./metricCatalog.js";

// Syncs GraphNodes to entities in the database

interface EntityRow {
  id: string;
  name: string;
  site?: { name: string } | null;
  workcenter?: { name: string } | null;
}
interface ModelDelegate {
  findMany(args: { where?: Record<string, unknown>; select: Record<string, unknown> }): Promise<EntityRow[]>;
}

// Path segments keep same-named nodes in a site from colliding on GraphNode.name.
const SITE = (row: EntityRow): string => row.site?.name ?? "(unknown site)";

interface KindConfig {
  delegate: string; // Prisma client delegate, e.g. "station"
  where?: Record<string, unknown>; // read filter (skip soft-deleted)
  select: Record<string, unknown>;
  nodeName: (row: EntityRow) => string;
}

const KIND_CONFIG: Record<string, KindConfig> = {
  Site: {
    delegate: "site",
    select: { id: true, name: true },
    nodeName: (row) => row.name,
  },
  Workcenter: {
    delegate: "workcenter",
    select: { id: true, name: true, site: { select: { name: true } } },
    nodeName: (row) => `${SITE(row)} / ${row.name}`,
  },
  Station: {
    delegate: "station",
    where: { deletedAt: null, archivedAt: null }, // only Station carries soft-delete columns
    select: { id: true, name: true, site: { select: { name: true } }, workcenter: { select: { name: true } } },
    nodeName: (row) =>
      row.workcenter ? `${SITE(row)} / ${row.workcenter.name} / ${row.name}` : `${SITE(row)} / ${row.name}`,
  },
};

// Static per-kind property schema (§4.6): every node of a kind gets these properties.
interface PropertySpec {
  name: string;
  resolverType: string;
  resolver: Record<string, unknown>;
}

// Additive/ratio schema derived from the metric catalog so materialized props and the picker can't drift.
const ROLLUP_CHILD: Record<string, { childKind: string; relation: string }> = {
  Workcenter: { childKind: "Station", relation: "stations" },
  Site: { childKind: "Workcenter", relation: "workcenters" },
};

const metricLeaf = (field: MetricField): PropertySpec => ({
  name: metricPropertyName(field.key),
  resolverType: "metric",
  resolver: { type: "metric", granularity: "SHIFT", metricKey: field.key },
});

const sumRollup = (field: MetricField, childKind: string, relation: string): PropertySpec => {
  const name = metricPropertyName(field.key);
  return {
    name,
    resolverType: "rollup",
    resolver: { type: "rollup", childKind, relation, childProperty: name, aggregation: "sum" },
  };
};

// Station mirrors the metric leaf; Workcenter/Site sum it over their children.
const additiveSpecs = (kind: string): PropertySpec[] => {
  const child = ROLLUP_CHILD[kind];
  return additiveFields().map((f) => (child ? sumRollup(f, child.childKind, child.relation) : metricLeaf(f)));
};

// Ratio KPIs as expr over the summed components (§8.6).
interface RatioSpec {
  name: string;
  deps: string[]; // component property names, e.g. "shift_runSeconds"
  build: (idByName: Map<string, string>) => string;
}

// Substitute each component key in the formula with its property's mathjs symbol; longest key first.
const buildRatioExpr = (field: MetricField, idByName: Map<string, string>): string => {
  const keys = [...(field.deps ?? [])].sort((a, b) => b.length - a.length);
  let expr = field.formula as string;
  for (const key of keys) {
    const symbol = prefixPropertyId(idByName.get(metricPropertyName(key)) as string);
    expr = expr.replace(new RegExp(`\\b${key}\\b`, "g"), symbol);
  }
  return expr;
};

const RATIO_SPECS: RatioSpec[] = ratioFields().map((f) => ({
  name: metricPropertyName(f.key),
  deps: (f.deps ?? []).map((d) => metricPropertyName(d)),
  build: (idByName) => buildRatioExpr(f, idByName),
}));

// Kinds that carry at least one ratio field.
const RATIO_KINDS = new Set(ratioFields().flatMap((f) => f.kinds));

const KIND_PROPERTIES: Record<string, PropertySpec[]> = Object.fromEntries(
  DEFAULT_KINDS.map((kind) => [kind, additiveSpecs(kind)]),
);

export interface NodeSyncResult {
  synced: Record<string, number>; // live entities upserted per kind
  pruned: Record<string, number>; // nodes soft-deleted per kind (entity gone)
  properties: Record<string, number>; // property rows materialized per kind
}

// Upsert one node on the (entityType, entityId) unique.
async function upsertNode(prisma: PrismaClient, kind: string, config: KindConfig, row: EntityRow) {
  const name = config.nodeName(row);
  return prisma.graphNode.upsert({
    where: { entityType_entityId: { entityType: kind, entityId: row.id } },
    create: { name, kind, entityType: kind, entityId: row.id },
    update: { name, kind, isDeleted: false },
  });
}

// Upsert the kind's static schema onto a node; return name→id. Never prunes editor-added props.
async function materializeSchema(
  prisma: PrismaClient,
  nodeId: string,
  specs: PropertySpec[],
): Promise<Map<string, string>> {
  const idByName = new Map<string, string>();
  for (const spec of specs) {
    const property = await prisma.graphProperty.upsert({
      where: { nodeId_name: { nodeId, name: spec.name } },
      create: { nodeId, name: spec.name, resolverType: spec.resolverType, resolver: spec.resolver },
      update: { resolverType: spec.resolverType, resolver: spec.resolver, isDeleted: false },
    });
    idByName.set(spec.name, property.id);
  }
  return idByName;
}

// Materialize ratio exprs with persisted component→expr edges so the scheduler recomputes on rollup.
async function materializeRatios(prisma: PrismaClient, nodeId: string, idByName: Map<string, string>): Promise<number> {
  let count = 0;
  for (const ratio of RATIO_SPECS) {
    if (!ratio.deps.every((d) => idByName.has(d))) continue;
    const resolver = { type: "expr", expression: ratio.build(idByName) };
    const exprProp = await prisma.graphProperty.upsert({
      where: { nodeId_name: { nodeId, name: ratio.name } },
      create: { nodeId, name: ratio.name, resolverType: "expr", resolver },
      update: { resolverType: "expr", resolver, isDeleted: false },
    });
    await prisma.graphEdge.deleteMany({ where: { toPropertyId: exprProp.id } });
    await prisma.graphEdge.createMany({
      data: ratio.deps.map((d) => ({ fromPropertyId: idByName.get(d) as string, toPropertyId: exprProp.id })),
      skipDuplicates: true,
    });
    count += 1;
  }
  return count;
}

// Soft-delete nodes of this kind whose backing entity is gone.
async function pruneDeleted(prisma: PrismaClient, kind: string, rows: EntityRow[]): Promise<number> {
  const prune = await prisma.graphNode.updateMany({
    where: { entityType: kind, isDeleted: false, entityId: { notIn: rows.map((row) => row.id) } },
    data: { isDeleted: true },
  });
  return prune.count;
}

// Reconcile and materialize one kind: upsert live nodes + schema, then prune dead ones.
async function syncKind(
  prisma: PrismaClient,
  kind: string,
): Promise<{ synced: number; pruned: number; properties: number }> {
  const config = KIND_CONFIG[kind];
  if (!config) throw new Error(`syncNodes: no sync config for kind "${kind}"`);
  const delegate = (prisma as unknown as Record<string, ModelDelegate | undefined>)[config.delegate];
  if (!delegate) throw new Error(`syncNodes: no Prisma delegate "${config.delegate}" for kind "${kind}"`);

  const rows = await delegate.findMany({ where: config.where, select: config.select });
  const specs = KIND_PROPERTIES[kind] ?? [];
  let properties = 0;

  for (const row of rows) {
    const node = await upsertNode(prisma, kind, config, row);
    const idByName = await materializeSchema(prisma, node.id, specs);
    properties += idByName.size;
    if (RATIO_KINDS.has(kind)) properties += await materializeRatios(prisma, node.id, idByName);
  }

  const pruned = await pruneDeleted(prisma, kind, rows);
  return { synced: rows.length, pruned, properties };
}

// Idempotent one-time sync (§4.6/M4): reconcile GraphNodes to entities and materialize each kind's schema.
export async function syncNodes(
  prisma: PrismaClient,
  kinds: readonly string[] = DEFAULT_KINDS,
): Promise<NodeSyncResult> {
  const synced: Record<string, number> = {};
  const pruned: Record<string, number> = {};
  const properties: Record<string, number> = {};

  for (const kind of kinds) {
    const result = await syncKind(prisma, kind);
    synced[kind] = result.synced;
    pruned[kind] = result.pruned;
    properties[kind] = result.properties;
  }

  return { synced, pruned, properties };
}
