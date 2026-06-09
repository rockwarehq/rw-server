import type { PrismaClient } from "@rw/db";

import { DEFAULT_KINDS } from "./entityCatalog.js";
import { symbolFor } from "./expr.js";

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

// Additive station SHIFT metrics (MetricBucket counters). Each becomes a
// metric-mirror leaf on Station and a rollup{sum} on Workcenter + Site — these are
// extensive quantities, so summing across children is correct. Ratios (oee,
// availability, performance, quality) are NOT here: they roll up as expr over
// these summed components (Phase 2 / RATIO_PROPERTIES). Keys must match the bridge's
// MIRRORED_METRIC_KEYS and the BucketSnapshot field names.
const COUNTER_KEYS = [
  "totalCycles",
  "goodCycles",
  "badCycles",
  "expectedCycles",
  "totalItems",
  "goodItems",
  "badItems",
  "expectedItems",
  "runSeconds",
  "downSeconds",
  "plannedDownSeconds",
  "unplannedDownSeconds",
  "plannedProductionSeconds",
  "idealCycleSeconds",
  "totalCycleSeconds",
  "elapsedExpectedCycles",
  "elapsedExpectedItems",
  "elapsedPlannedProductionSeconds",
];

const metricLeaf = (key: string): PropertySpec => ({
  name: `shift_${key}`,
  resolverType: "metric",
  resolver: { type: "metric", granularity: "SHIFT", metricKey: key },
});

const sumRollup = (key: string, childKind: string, relation: string): PropertySpec => ({
  name: `shift_${key}`,
  resolverType: "rollup",
  resolver: { type: "rollup", childKind, relation, childProperty: `shift_${key}`, aggregation: "sum" },
});

const KIND_PROPERTIES: Record<string, PropertySpec[]> = {
  Station: COUNTER_KEYS.map((k) => metricLeaf(k)),
  Workcenter: COUNTER_KEYS.map((k) => sumRollup(k, "Station", "stations")),
  Site: COUNTER_KEYS.map((k) => sumRollup(k, "Workcenter", "workcenters")),
};

// Ratio KPIs derived from the summed components via expr (Phase 2 / §8.6). Each
// names the component properties it needs; the expression is built per node from
// those components' actual IDs (mathjs symbols, hyphen-safe). Materialized only on
// kinds carrying the summed components (Workcenter, Site) — never on Station leaves.
interface RatioSpec {
  name: string;
  deps: string[];
  build: (idByName: Map<string, string>) => string;
}

const sym = (idByName: Map<string, string>, name: string): string => symbolFor(idByName.get(name) as string);

const RATIO_SPECS: RatioSpec[] = [
  {
    name: "shift_availability",
    deps: ["shift_runSeconds", "shift_elapsedPlannedProductionSeconds"],
    build: (id) => `${sym(id, "shift_runSeconds")} / ${sym(id, "shift_elapsedPlannedProductionSeconds")}`,
  },
  {
    name: "shift_performance",
    deps: ["shift_idealCycleSeconds", "shift_runSeconds"],
    build: (id) => `${sym(id, "shift_idealCycleSeconds")} / ${sym(id, "shift_runSeconds")}`,
  },
  {
    name: "shift_quality",
    deps: ["shift_goodItems", "shift_totalItems"],
    build: (id) => `${sym(id, "shift_goodItems")} / ${sym(id, "shift_totalItems")}`,
  },
  {
    name: "shift_oee",
    deps: ["shift_idealCycleSeconds", "shift_goodItems", "shift_elapsedPlannedProductionSeconds", "shift_totalItems"],
    build: (id) =>
      `(${sym(id, "shift_idealCycleSeconds")} * ${sym(id, "shift_goodItems")}) / ` +
      `(${sym(id, "shift_elapsedPlannedProductionSeconds")} * ${sym(id, "shift_totalItems")})`,
  },
];

const RATIO_KINDS = new Set(["Workcenter", "Site"]);

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
      const idByName = new Map<string, string>();
      for (const spec of specs) {
        const property = await prisma.graphProperty.upsert({
          where: { nodeId_name: { nodeId: node.id, name: spec.name } },
          create: { nodeId: node.id, name: spec.name, resolverType: spec.resolverType, resolver: spec.resolver },
          update: { resolverType: spec.resolverType, resolver: spec.resolver, isDeleted: false },
        });
        idByName.set(spec.name, property.id);
        propertyCount += 1;
      }

      // Phase 2: ratio KPIs as expr over the summed components. Built per node from
      // the component IDs, with persisted GraphEdges (component -> expr) so the
      // scheduler recomputes the ratio when a component rolls up.
      if (RATIO_KINDS.has(kind)) {
        for (const ratio of RATIO_SPECS) {
          if (!ratio.deps.every((d) => idByName.has(d))) continue;
          const resolver = { type: "expr", expression: ratio.build(idByName) };
          const exprProp = await prisma.graphProperty.upsert({
            where: { nodeId_name: { nodeId: node.id, name: ratio.name } },
            create: { nodeId: node.id, name: ratio.name, resolverType: "expr", resolver },
            update: { resolverType: "expr", resolver, isDeleted: false },
          });
          await prisma.graphEdge.deleteMany({ where: { toPropertyId: exprProp.id } });
          await prisma.graphEdge.createMany({
            data: ratio.deps.map((d) => ({ fromPropertyId: idByName.get(d) as string, toPropertyId: exprProp.id })),
            skipDuplicates: true,
          });
          propertyCount += 1;
        }
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
