// Metric Catalog: the KPI fields the entity catalog can't reflect. The entity
// catalog (entityCatalog.ts) answers "what kinds exist and how do they relate" —
// reflected from Prisma relations. It cannot answer "what KPI fields can I pick",
// because those fields live on the polymorphic MetricBucket table, linked to Site/
// Workcenter/Station by an (entityType, entityId) discriminator rather than typed
// relations — so DMMF reflection finds no relation to follow and can't tell which
// fields belong to which kind. This module supplies that declared layer.
//
// It is the single source of truth for the pickable KPI set: node-sync.ts derives
// the materialized properties from it, and the catalog endpoint exposes it to the
// picker. One declaration, two consumers — so what gets materialized and what the
// picker advertises cannot drift apart.

import type { PrismaClient } from "@rw/db";

// additive  — extensive quantity, summed across children (metric leaf on Station,
//             rollup{sum} on Workcenter/Site).
// ratio     — intensive quantity, recomputed per level via expr over components,
//             never summed. `deps` + `formula` define the computation.
// display   — leaf-only, not rolled up. Reserved for fields like currentStandardCycle;
//             none are materialized yet (no mirror path), so METRIC_FIELDS carries
//             none today — see the boot assertion's DEFERRED set.
export type MetricRole = "additive" | "ratio" | "display";
export type MetricUnit = "count" | "seconds" | "ratio";

export interface MetricField {
  key: string; // MetricBucket column, e.g. "goodItems", "oee"
  unit: MetricUnit; // picker formatting hint
  role: MetricRole;
  kinds: string[]; // applicable kinds (today every wired field applies to all three)
  granularities: string[]; // wired granularities; only SHIFT is materialized today
  deps?: string[]; // ratio only: component keys (must be additive fields)
  formula?: string; // ratio only: expression in component-key terms (display + build source)
}

// The single granularity wired end-to-end today. Property names are `<gran>_<key>`
// (e.g. shift_goodItems); the bridge publishes metrics.<entityId>.SHIFT.<key>.
export const MIRRORED_GRANULARITY = "SHIFT";

// Graph property name for a metric field at the wired granularity.
export const metricPropertyName = (key: string): string => `${MIRRORED_GRANULARITY.toLowerCase()}_${key}`;

const ALL_KINDS = ["Site", "Workcenter", "Station"];
const G = [MIRRORED_GRANULARITY];

const counter = (key: string, unit: MetricUnit): MetricField => ({
  key,
  unit,
  role: "additive",
  kinds: ALL_KINDS,
  granularities: G,
});

const ratio = (key: string, deps: string[], formula: string): MetricField => ({
  key,
  unit: "ratio",
  role: "ratio",
  kinds: ALL_KINDS,
  granularities: G,
  deps,
  formula,
});

// The pickable KPI set. Additive counters mirror MetricBucket's extensive columns
// (must stay in lockstep with the bridge's MIRRORED_METRIC_KEYS); ratios are the
// computed OEE family, expressed over those counters.
export const METRIC_FIELDS: MetricField[] = [
  counter("totalCycles", "count"),
  counter("goodCycles", "count"),
  counter("badCycles", "count"),
  counter("expectedCycles", "count"),
  counter("totalItems", "count"),
  counter("goodItems", "count"),
  counter("badItems", "count"),
  counter("expectedItems", "count"),
  counter("runSeconds", "seconds"),
  counter("downSeconds", "seconds"),
  counter("plannedDownSeconds", "seconds"),
  counter("unplannedDownSeconds", "seconds"),
  counter("plannedProductionSeconds", "seconds"),
  counter("idealCycleSeconds", "seconds"),
  counter("totalCycleSeconds", "seconds"),
  counter("elapsedExpectedCycles", "count"),
  counter("elapsedExpectedItems", "count"),
  counter("elapsedPlannedProductionSeconds", "seconds"),
  ratio("availability", ["runSeconds", "elapsedPlannedProductionSeconds"], "runSeconds / elapsedPlannedProductionSeconds"),
  ratio("performance", ["idealCycleSeconds", "runSeconds"], "idealCycleSeconds / runSeconds"),
  ratio("quality", ["goodItems", "totalItems"], "goodItems / totalItems"),
  ratio(
    "oee",
    ["idealCycleSeconds", "goodItems", "elapsedPlannedProductionSeconds", "totalItems"],
    "(idealCycleSeconds * goodItems) / (elapsedPlannedProductionSeconds * totalItems)",
  ),
];

export const metricsForKind = (kind: string): MetricField[] => METRIC_FIELDS.filter((m) => m.kinds.includes(kind));

export const additiveFields = (): MetricField[] => METRIC_FIELDS.filter((m) => m.role === "additive");
export const ratioFields = (): MetricField[] => METRIC_FIELDS.filter((m) => m.role === "ratio");

// Structural / bookkeeping columns on MetricBucket — never pickable KPIs.
const HOUSEKEEPING = new Set([
  "id",
  "siteId",
  "entityType",
  "entityId",
  "entityName",
  "path",
  "granularity",
  "granularityName",
  "startTime",
  "durationSeconds",
  "shiftInstanceId",
  "businessDate",
  "businessShift",
  "createdAt",
  "updatedAt",
]);

// Known KPI-ish columns intentionally not yet exposed (no mirror path / display-only).
// Listed so the assertion can tell "deferred" apart from "someone added a column and
// forgot to classify it".
const DEFERRED = new Set(["currentStandardCycle", "currentJobId", "currentJobName"]);

interface RuntimeField {
  name: string;
  kind: "scalar" | "object" | "enum";
}
interface RuntimeModel {
  fields: RuntimeField[];
}

// Drift guard: reflect MetricBucket's scalar columns and assert the catalog stays in
// lockstep with the schema. Names/types come from the DB (can't drift); the semantics
// (role/kinds/formula) are declared above. If a new KPI column is added to MetricBucket
// without being declared or deferred, this throws at boot rather than silently leaving
// it out of the picker. Conversely, a declared field with no backing column also throws.
export function assertMetricCatalogComplete(prisma: PrismaClient): void {
  const dm = (prisma as unknown as { _runtimeDataModel?: { models?: Record<string, RuntimeModel> } })
    ._runtimeDataModel;
  const model = dm?.models?.MetricBucket;
  if (!model) throw new Error("metricCatalog: MetricBucket not found in Prisma runtime model (schema change?)");

  const columns = new Set(model.fields.filter((f) => f.kind !== "object").map((f) => f.name));
  const declared = new Set(METRIC_FIELDS.map((m) => m.key));

  const unclassified = [...columns].filter((c) => !HOUSEKEEPING.has(c) && !DEFERRED.has(c) && !declared.has(c));
  if (unclassified.length) {
    throw new Error(
      `metricCatalog: unclassified MetricBucket columns: ${unclassified.join(", ")} — ` +
        "add to METRIC_FIELDS (pickable) or DEFERRED (intentionally not exposed).",
    );
  }

  const phantom = [...declared].filter((k) => !columns.has(k));
  if (phantom.length) {
    throw new Error(`metricCatalog: METRIC_FIELDS reference columns absent from MetricBucket: ${phantom.join(", ")}`);
  }

  // Every ratio's components must be additive fields, or the rollup/expr wiring breaks.
  for (const r of ratioFields()) {
    const missing = (r.deps ?? []).filter((d) => !METRIC_FIELDS.some((m) => m.key === d && m.role === "additive"));
    if (missing.length) {
      throw new Error(`metricCatalog: ratio "${r.key}" depends on non-additive/unknown fields: ${missing.join(", ")}`);
    }
  }
}
