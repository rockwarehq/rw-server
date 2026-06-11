// Metric Catalog: the KPI fields the catalog can't reflect.
// MetricBucket is polymorphic so this declares pickable KPIs

import type { PrismaClient } from "@rw/db";

import { MIRRORED_GRANULARITY, MIRRORED_METRIC_KEYS, type MirroredMetricKey } from "@rw/runtime/graph-subjects";

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

export { MIRRORED_GRANULARITY };

// Graph property name for a metric field at the wired granularity.
export const metricPropertyName = (key: string): string => `${MIRRORED_GRANULARITY.toLowerCase()}_${key}`;

const ALL_KINDS = ["Site", "Workcenter", "Station"];
const G = [MIRRORED_GRANULARITY];


const COUNTER_UNITS: Record<MirroredMetricKey, MetricUnit> = {
  totalCycles: "count",
  goodCycles: "count",
  badCycles: "count",
  expectedCycles: "count",
  totalItems: "count",
  goodItems: "count",
  badItems: "count",
  expectedItems: "count",
  runSeconds: "seconds",
  downSeconds: "seconds",
  plannedDownSeconds: "seconds",
  unplannedDownSeconds: "seconds",
  plannedProductionSeconds: "seconds",
  idealCycleSeconds: "seconds",
  totalCycleSeconds: "seconds",
  elapsedExpectedCycles: "count",
  elapsedExpectedItems: "count",
  elapsedPlannedProductionSeconds: "seconds",
};

const counter = (key: MirroredMetricKey): MetricField => ({
  key,
  unit: COUNTER_UNITS[key],
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


export const METRIC_FIELDS: MetricField[] = [
  ...MIRRORED_METRIC_KEYS.map(counter),
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

// Intentionally not exposed as an example how to defer
const DEFERRED = new Set(["currentStandardCycle", "currentJobId", "currentJobName"]);

interface RuntimeField {
  name: string;
  kind: "scalar" | "object" | "enum";
}
interface RuntimeModel {
  fields: RuntimeField[];
}

// drift protection
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
