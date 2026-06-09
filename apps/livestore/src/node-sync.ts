import type { PrismaClient } from "@rw/db";

import { DEFAULT_KINDS } from "./entityCatalog.js";

interface EntityRow {
  id: string;
  name: string;
  site?: { name: string } | null;
  workcenter?: { name: string } | null;
}
interface ModelDelegate {
  findMany(args: { where?: Record<string, unknown>; select: Record<string, unknown> }): Promise<EntityRow[]>;
}

// Hierarchical path node names: bare site, "<Site> / <Workcenter>", and
// "<Site> / <Workcenter> / <Station>". The extra path segment keeps a workcenter
// and a station that share a name in the same site from colliding on the global
// GraphNode.name unique. Stations placed directly under a site (no workcenter)
// fall back to "<Site> / <Station>". Single-workspace, so site names are unique.
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

// Static per-kind property schema (spec §4.6 property-set convention): every node
// of a kind gets these properties, so $kind.<prop> resolves uniformly. Defined in
// code (not a UI template — that's deferred §15). Resolver configs are static per
// kind; per-instance binding (which station) comes from the node's entityType/
// entityId at runtime, so nothing here depends on the specific instance.
interface PropertySpec {
  name: string;
  resolverType: string;
  resolver: Record<string, unknown>;
}

const KIND_PROPERTIES: Record<string, PropertySpec[]> = {
  Station: [
    {
      // Leaf: mirror the station's current SHIFT MetricBucket goodItems, push-fed
      // over NATS by the metric mirror (subject metrics.<stationId>.SHIFT.goodItems).
      name: "shift_goodItems",
      resolverType: "metric",
      resolver: { type: "metric", granularity: "SHIFT", metricKey: "goodItems" },
    },
  ],
  Workcenter: [
    {
      // Sum the stations' shift_goodItems. goodItems is additive, so a plain
      // rollup{sum} is correct (no expr needed). Evaluates once the reactive
      // scheduler (M3) + rollup resolver (M6) land.
      name: "shift_goodItems",
      resolverType: "rollup",
      resolver: {
        type: "rollup",
        childKind: "Station",
        relation: "stations",
        childProperty: "shift_goodItems",
        aggregation: "sum",
      },
    },
  ],
  Site: [
    {
      name: "shift_goodItems",
      resolverType: "rollup",
      resolver: {
        type: "rollup",
        childKind: "Workcenter",
        relation: "workcenters",
        childProperty: "shift_goodItems",
        aggregation: "sum",
      },
    },
  ],
};

export interface NodeSyncResult {
  synced: Record<string, number>; // live entities upserted per kind
  pruned: Record<string, number>; // nodes soft-deleted per kind (entity gone)
  properties: Record<string, number>; // property rows materialized per kind
}

// One-time sync (spec §4.6 / M4): reconcile GraphNodes against existing entity
// instances of each kind, bound via entityType + entityId, and materialize each
// kind's property schema onto every node. Idempotent — upserts live entities on
// the (entityType, entityId) unique, soft-deletes nodes whose backing entity is
// gone, and upserts the schema properties without pruning user-added ones — so it
// is safe to run on every boot and after each deploy. Live auto-instantiation
// (new entity -> node) is deferred (§15).
export async function syncNodes(
  prisma: PrismaClient,
  kinds: readonly string[] = DEFAULT_KINDS,
): Promise<NodeSyncResult> {
  const synced: Record<string, number> = {};
  const pruned: Record<string, number> = {};
  const properties: Record<string, number> = {};

  for (const kind of kinds) {
    const config = KIND_CONFIG[kind];
    if (!config) throw new Error(`syncNodes: no sync config for kind "${kind}"`);
    const delegate = (prisma as unknown as Record<string, ModelDelegate | undefined>)[config.delegate];
    if (!delegate) throw new Error(`syncNodes: no Prisma delegate "${config.delegate}" for kind "${kind}"`);

    const rows = await delegate.findMany({ where: config.where, select: config.select });
    const specs = KIND_PROPERTIES[kind] ?? [];
    let propertyCount = 0;

    for (const row of rows) {
      const name = config.nodeName(row);
      const node = await prisma.graphNode.upsert({
        where: { entityType_entityId: { entityType: kind, entityId: row.id } },
        create: { name, kind, entityType: kind, entityId: row.id },
        update: { name, kind, isDeleted: false },
      });

      // Materialize the kind's property schema onto this node. Upsert only — never
      // prune, so editor-added ad-hoc properties (§4.6) survive a re-sync.
      for (const spec of specs) {
        await prisma.graphProperty.upsert({
          where: { nodeId_name: { nodeId: node.id, name: spec.name } },
          create: { nodeId: node.id, name: spec.name, resolverType: spec.resolverType, resolver: spec.resolver },
          update: { resolverType: spec.resolverType, resolver: spec.resolver, isDeleted: false },
        });
        propertyCount += 1;
      }
    }

    synced[kind] = rows.length;
    properties[kind] = propertyCount;

    // Reconcile deletions: any live node of this kind whose entity is no longer
    // present (deleted/archived Station, or hard-deleted Site/Workcenter) is
    // soft-deleted so it (and its properties) drop out of the in-memory graph on
    // the next load.
    const prune = await prisma.graphNode.updateMany({
      where: { entityType: kind, isDeleted: false, entityId: { notIn: rows.map((row) => row.id) } },
      data: { isDeleted: true },
    });
    pruned[kind] = prune.count;
  }

  return { synced, pruned, properties };
}
