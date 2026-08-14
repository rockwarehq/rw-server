// Parity contract between the two livestore metric vocabularies and the
// canonical semantic catalog in @rockwarehq/metrics:
//
//   METRIC_FIELDS  (metric-fields.ts)  — pickable MetricBucket KPI columns
//   BASE_COUNTERS / DERIVED_FIELDS (graph-types.ts) — graph node fields,
//     reached here through the exported IMM_GRAPH_TYPE_NAMESPACE
//   DIMENSIONS / MEASURES / BUCKET_ADDITIVE_KEYS (@rockwarehq/metrics)
//
// The vocabularies are intentionally NOT identical — MetricBucket carries
// PostgreSQL generated columns the dependency-free catalog expands inline:
//
//   goodCycles               = totalCycles - badCycles
//   goodItems                = totalItems  - badItems
//   plannedProductionSeconds = durationSeconds - plannedDownSeconds
//
// These tests pin the exact relationship (expansions and all) so any drift
// between the three sources breaks CI. Expected formula strings are
// hardcoded per key on purpose: four simple formulas, explicit and readable.

import { BUCKET_ADDITIVE_KEYS, formulaFields, MEASURES } from "@rockwarehq/metrics";
import { describe, expect, it } from "vitest";

import { IMM_GRAPH_TYPE_NAMESPACE } from "./graph-types.js";
import { additiveFields, ratioFields } from "./metric-fields.js";
import { buildLivestoreCapabilityManifest } from "./manifest.js";
import { formulaToString } from "./metric-formula.js";

// Catalog ratio formulas rendered by formulaToString — the catalog expands
// goodItems to (totalItems - badItems) because generated columns don't exist
// at its level of abstraction.
const CATALOG_RATIO_FORMULAS: Record<string, string> = {
  availability: "runSeconds / elapsedPlannedProductionSeconds",
  performance: "idealCycleSeconds / runSeconds",
  quality: "(totalItems - badItems) / totalItems",
  oee: "(idealCycleSeconds * (totalItems - badItems)) / (elapsedPlannedProductionSeconds * totalItems)",
};

// METRIC_FIELDS formula strings — written over MetricBucket columns, so they
// reference the generated column goodItems directly.
const METRIC_FIELD_RATIO_FORMULAS: Record<string, string> = {
  availability: "runSeconds / elapsedPlannedProductionSeconds",
  performance: "idealCycleSeconds / runSeconds",
  quality: "goodItems / totalItems",
  oee: "(idealCycleSeconds * goodItems) / (elapsedPlannedProductionSeconds * totalItems)",
};

// Expand the goodItems generated column to its defining expression, mapping a
// MetricBucket-column formula onto the catalog's canonical rendering.
const expandGeneratedColumns = (expression: string): string =>
  expression.replace(/\bgoodItems\b/g, "(totalItems - badItems)");

// Same expansion at the deps level: depending on goodItems means depending on
// the columns it is generated from.
const expandGeneratedDeps = (deps: readonly string[]): Set<string> => {
  const expanded = new Set<string>();
  for (const dep of deps) {
    if (dep === "goodItems") {
      expanded.add("totalItems");
      expanded.add("badItems");
    } else {
      expanded.add(dep);
    }
  }
  return expanded;
};

describe("METRIC_FIELDS ratios vs @rockwarehq/metrics MEASURES", () => {
  it("covers exactly the catalog's ratio measures", () => {
    const catalogRatioKeys = Object.values(MEASURES)
      .filter((m) => m.kind === "ratio")
      .map((m) => m.key)
      .sort();
    const fieldRatioKeys = ratioFields()
      .map((f) => f.key)
      .sort();
    expect(fieldRatioKeys).toEqual(catalogRatioKeys);
    expect(fieldRatioKeys).toEqual(["availability", "oee", "performance", "quality"]);
  });

  it("each ratio formula is algebraically the catalog formula (modulo generated-column expansion)", () => {
    for (const field of ratioFields()) {
      const measure = MEASURES[field.key];
      expect(measure, `catalog measure for "${field.key}"`).toBeDefined();
      if (!measure?.formula) throw new Error(`catalog ratio "${field.key}" has no formula`);

      const rendered = formulaToString(measure.formula);
      expect(rendered, `catalog AST rendering for "${field.key}"`).toBe(CATALOG_RATIO_FORMULAS[field.key]);
      expect(field.formula, `METRIC_FIELDS formula for "${field.key}"`).toBe(METRIC_FIELD_RATIO_FORMULAS[field.key]);
      // The bridge between the two: expanding goodItems yields the exact
      // canonical rendering of the catalog AST.
      expect(expandGeneratedColumns(field.formula ?? ""), `expanded formula for "${field.key}"`).toBe(rendered);
    }
  });

  it("each ratio's deps match the catalog formula's fields (modulo expansion), and catalog deps = formula fields + guards", () => {
    for (const field of ratioFields()) {
      const measure = MEASURES[field.key];
      if (!measure?.formula) throw new Error(`catalog ratio "${field.key}" has no formula`);

      const formulaDeps = new Set(formulaFields(measure.formula));
      // METRIC_FIELDS deps list exactly what the formula reads (in
      // MetricBucket-column terms). The catalog's `deps` is wider: it also
      // includes fields read only by the null/zero guards.
      expect(expandGeneratedDeps(field.deps ?? []), `deps for "${field.key}"`).toEqual(formulaDeps);

      const guardKeys = [measure.guards?.nullWhenZero, measure.guards?.zeroWhenZero].filter(
        (k): k is string => k !== undefined,
      );
      expect(new Set(measure.deps), `catalog deps for "${field.key}"`).toEqual(new Set([...formulaDeps, ...guardKeys]));
    }
  });
});

describe("METRIC_FIELDS additive keys vs BUCKET_ADDITIVE_KEYS", () => {
  it("additive keys are BUCKET_ADDITIVE_KEYS plus the DB-generated columns", () => {
    // MetricBucket's generated columns are real, pickable KPI columns for
    // METRIC_FIELDS, but the catalog only models the stored additive inputs
    // (rollup writers must never write generated columns).
    const GENERATED_COLUMNS = ["goodCycles", "goodItems", "plannedProductionSeconds"];
    const additiveKeys = additiveFields().map((f) => f.key);
    expect(new Set(additiveKeys)).toEqual(new Set([...BUCKET_ADDITIVE_KEYS, ...GENERATED_COLUMNS]));
    // ...and nothing overlaps: a generated column must never be listed as a
    // stored additive measure in the catalog.
    expect(BUCKET_ADDITIVE_KEYS.filter((k) => GENERATED_COLUMNS.includes(k))).toEqual([]);
  });
});

describe("graph-types DERIVED_FIELDS vs @rockwarehq/metrics ratio formulas", () => {
  // The derived expressions are written over graph field display keys; the
  // metric resolver maps display keys to MetricBucket columns via metricKey
  // (e.g. netRunSeconds -> idealCycleSeconds). Rebuild that alias map from
  // the exported station schema and prove each expression is the catalog
  // formula — this pins the future "derive graph-types from the catalog"
  // switch as output-identical before anyone flips it.
  const station = IMM_GRAPH_TYPE_NAMESPACE.types.find((t) => t.key === "station");
  if (!station) throw new Error("@imm/station schema missing");

  const metricKeyByDisplayKey = new Map<string, string>();
  for (const field of station.fields) {
    if (field.resolverType !== "metric") continue;
    metricKeyByDisplayKey.set(field.key, (field.resolver as { metricKey: string }).metricKey);
  }

  const toColumnExpression = (expression: string): string =>
    expression.replace(/\$field\.([A-Za-z0-9_]+)/g, (_match, key: string) => metricKeyByDisplayKey.get(key) ?? key);

  const exprFieldsOf = (typeKey: string): Map<string, string> => {
    const type = IMM_GRAPH_TYPE_NAMESPACE.types.find((t) => t.key === typeKey);
    if (!type) throw new Error(`@imm/${typeKey} schema missing`);
    return new Map(
      type.fields
        .filter((f) => f.resolverType === "expr")
        .map((f) => [f.key, (f.resolver as { expression: string }).expression]),
    );
  };

  const stationExprs = exprFieldsOf("station");

  it("station derives exactly goodItems + the four catalog ratios", () => {
    expect([...stationExprs.keys()].sort()).toEqual(["availability", "goodItems", "oee", "performance", "quality"]);
  });

  it("every ratio expression, mapped to column keys, is the catalog formula", () => {
    for (const key of ["availability", "performance", "quality", "oee"]) {
      const expression = stationExprs.get(key);
      if (!expression) throw new Error(`derived field "${key}" missing`);
      const measure = MEASURES[key];
      if (!measure?.formula) throw new Error(`catalog ratio "${key}" has no formula`);
      expect(toColumnExpression(expression), `derived expression for "${key}"`).toBe(formulaToString(measure.formula));
    }
  });

  it("the goodItems expression is the generated-column identity", () => {
    // goodItems is not a catalog ratio — it recomputes MetricBucket's
    // generated column (totalItems - badItems) at rollup levels.
    expect(toColumnExpression(stationExprs.get("goodItems") ?? "")).toBe("totalItems - badItems");
  });

  it("workcenter and site reuse the station derived expressions verbatim", () => {
    for (const typeKey of ["workcenter", "site"]) {
      expect(exprFieldsOf(typeKey), `derived fields on @imm/${typeKey}`).toEqual(stationExprs);
    }
  });
});

describe("capability manifest metrics section", () => {
  it("serves the catalog measures, dimensions, and facts", () => {
    const { metrics } = buildLivestoreCapabilityManifest();

    expect(metrics.measures.map((m) => m.key).sort()).toEqual(Object.keys(MEASURES).sort());
    const oee = metrics.measures.find((m) => m.key === "oee");
    expect(oee).toMatchObject({
      kind: "ratio",
      unit: "ratio",
      formula: CATALOG_RATIO_FORMULAS.oee,
    });
    for (const measure of metrics.measures) {
      if (measure.kind === "additive") expect(measure.formula).toBeNull();
      else expect(measure.formula).toBeTruthy();
    }

    expect(metrics.dimensions.length).toBeGreaterThan(0);
    for (const dimension of metrics.dimensions) {
      expect(dimension.key).toBeTruthy();
      expect(dimension.label).toBeTruthy();
    }

    expect(metrics.facts.map((f) => f.key).sort()).toEqual(["bucket", "cycle", "downtime", "scrap"]);
    for (const fact of metrics.facts) {
      expect(fact.grains.length).toBeGreaterThan(0);
    }
    expect(metrics.facts.find((f) => f.key === "bucket")?.grains).toEqual(["SHIFT"]);
  });
});
