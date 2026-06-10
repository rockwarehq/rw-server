// Entity Catalog (Service 3): the schema's *shape* — kinds, scalar fields, and
// relations — reflected from Prisma at boot and held in memory. Derived data, so
// it is never persisted; rebuilt every boot, it cannot drift from schema.prisma.
//
// Prisma 7 dropped Prisma.dmmf; the runtime data model lives on the client as the
// internal `_runtimeDataModel`. Accessed here only — one place to fix on upgrade.

import type { PrismaClient } from "@rw/db";

import { assertMetricCatalogComplete, type MetricField, metricsForKind } from "./metricCatalog.js";

export interface CatalogScalar {
  name: string;
  type: string; // String | Int | Boolean | DateTime | Json | <enum>
}

export interface CatalogRelation {
  name: string;
  target: string; // related model (e.g. "Station")
  // true = the to-many (children) side. Prisma 7's runtime model omits relation
  // cardinality, so inferred from FK ownership: the to-one side holds the scalar
  // `<name>Id` (site→siteId); a relation with no backing FK is the to-many side.
  isList: boolean;
}

export interface EntityCatalogEntry {
  kind: string; // Prisma model name, e.g. "Workcenter"
  entityType: string; // graph entityType, e.g. "WORKCENTER"
  scalars: CatalogScalar[]; // Prisma columns (structure)
  relations: CatalogRelation[]; // Prisma relations (hierarchy)
  metrics: MetricField[]; // pickable KPI fields (from the metric catalog, not reflectable here)
}

interface RuntimeField {
  name: string;
  kind: "scalar" | "object" | "enum";
  type: string;
  isList?: boolean;
}
interface RuntimeModel {
  fields: RuntimeField[];
}
interface RuntimeDataModel {
  models: Record<string, RuntimeModel>;
}

export const DEFAULT_KINDS = ["Site", "Workcenter", "Station"] as const;

let catalog: Map<string, EntityCatalogEntry> | null = null;

export function loadEntityCatalog(
  prisma: PrismaClient,
  kinds: readonly string[] = DEFAULT_KINDS,
): Map<string, EntityCatalogEntry> {
  const dm = (prisma as unknown as { _runtimeDataModel?: RuntimeDataModel })._runtimeDataModel;
  if (!dm?.models) throw new Error("entityCatalog: prisma._runtimeDataModel unavailable (Prisma upgrade?)");

  // Validate the metric catalog against MetricBucket before folding it in, so a
  // schema/catalog drift fails fast at boot rather than surfacing as a dead picker entry.
  assertMetricCatalogComplete(prisma);

  const next = new Map<string, EntityCatalogEntry>();
  for (const kind of kinds) {
    const model = dm.models[kind];
    if (!model) throw new Error(`dmmf: model "${kind}" not found in schema`);

    const scalarNames = new Set(model.fields.filter((f) => f.kind !== "object").map((f) => f.name));
    const scalars: CatalogScalar[] = [];
    const relations: CatalogRelation[] = [];
    for (const f of model.fields) {
      if (f.kind === "object") {
        const isList = f.isList ?? !scalarNames.has(`${f.name}Id`);
        relations.push({ name: f.name, target: f.type, isList });
      } else {
        scalars.push({ name: f.name, type: f.type });
      }
    }
    next.set(kind, { kind, entityType: kind.toUpperCase(), scalars, relations, metrics: metricsForKind(kind) });
  }

  catalog = next;
  return catalog;
}

export function getEntityCatalog(): Map<string, EntityCatalogEntry> {
  if (!catalog) throw new Error("entityCatalog: catalog not loaded — call loadEntityCatalog() at boot");
  return catalog;
}

export function getEntityKind(kind: string): EntityCatalogEntry | undefined {
  return catalog?.get(kind);
}

// Child kinds reachable from `kind` via a to-many relation (the rollup traversal).
export function childKindsOf(kind: string): string[] {
  return (
    getEntityKind(kind)
      ?.relations.filter((r) => r.isList)
      .map((r) => r.target) ?? []
  );
}

// Resolve a named relation to its target kind (Service 14 rollup: childKind + relation).
export function relationTarget(kind: string, relationName: string): string | undefined {
  return getEntityKind(kind)?.relations.find((r) => r.name === relationName)?.target;
}
