/**
 * Semantic-layer catalog: dimensions, facts, and measures.
 *
 * This is data, not behavior — SQL snippets are plain strings over quoted
 * Postgres column names, and formulas are FormulaNode ASTs so consumers can
 * render them to SQL or evaluate them in TS (see evaluateRatioMeasure).
 *
 * Column names mirror packages/db/schema/*.prisma (Cycle, StationStateLog,
 * ItemDispositionLog, MetricBucket). This package stays dependency-free, so
 * drift protection lives with the consumers that own a PrismaClient.
 */

import { evaluateFormula, type FormulaNode } from "./formula.js";

export type MeasureUnit = "count" | "seconds" | "ratio" | "weight";
export type MeasureKind = "additive" | "ratio";

export interface DimensionDefinition {
  key: string;
  label: string;
  /** Default fact column; a fact can override via FactDefinition.dimensionColumns. */
  factColumn: string;
  /** Prisma model / table holding dimension attributes. Absent = degenerate dimension. */
  dimTable?: string;
  /** Human-readable column on dimTable. Absent = no single label column (e.g. versioned models). */
  labelColumn?: string;
}

/**
 * Null-vs-0 semantics for ratio measures, mirroring the MetricBucket
 * generated columns: null = "no production window" (undefined), 0 = "window
 * existed but nothing happened" (a real zero). Guards are checked before the
 * formula, nullWhenZero first; each fires when its field is <= 0.
 */
export interface MeasureGuards {
  nullWhenZero?: string;
  zeroWhenZero?: string;
}

export interface MeasureDefinition {
  key: string;
  label: string;
  unit: MeasureUnit;
  kind: MeasureKind;
  /** Additive only. "count" is COUNT(*) — no sql. "sum" (default) sums `sql`. */
  agg?: "sum" | "count";
  /** Additive sum only: SQL expression over quoted column names (Postgres). */
  sql?: string;
  /** Ratio only: additive measure keys read by the formula AND the guards. */
  deps?: string[];
  /** Ratio only: arithmetic over dep keys. */
  formula?: FormulaNode;
  /** Ratio only: see MeasureGuards. */
  guards?: MeasureGuards;
  /** Queries must group or filter by this dimension — for measures whose
   *  sums are dimensionally meaningless across it (e.g. material weights). */
  requiresDimension?: string;
}

export type FactKey = "cycle" | "downtime" | "scrap" | "items" | "materialUsage" | "bucket";

export interface FactDefinition {
  key: FactKey;
  /** Prisma model / table name. */
  table: string;
  /** Column (or SQL expression) giving the event time for windowing. */
  timeColumn: string;
  /** Dimension keys available on this fact. */
  dimensions: string[];
  /** Overrides when a dimension binds to a different column on this fact. */
  dimensionColumns?: Record<string, string>;
  /** Measure keys (from MEASURES) computable on this fact. */
  measures: string[];
  /** False when the table has no deletedAt column (default: soft-deleted). */
  softDelete?: boolean;
}

// ── Dimensions ───────────────────────────────────────────────────

export const DIMENSIONS: Record<string, DimensionDefinition> = {
  station: { key: "station", label: "Station", factColumn: "stationId", dimTable: "Station", labelColumn: "name" },
  workcenter: {
    key: "workcenter",
    label: "Workcenter",
    factColumn: "workcenterId",
    dimTable: "Workcenter",
    labelColumn: "name",
  },
  site: { key: "site", label: "Site", factColumn: "siteId", dimTable: "Site", labelColumn: "name" },
  shift: {
    key: "shift",
    label: "Shift",
    factColumn: "shiftInstanceId",
    dimTable: "ShiftInstance",
    labelColumn: "shiftName",
  },
  // Degenerate: the date value is its own label.
  businessDate: { key: "businessDate", label: "Business Date", factColumn: "businessDate" },
  // Job's display name lives on JobVersion (currentVersion) — no single labelColumn.
  job: { key: "job", label: "Job", factColumn: "jobId", dimTable: "Job" },
  operator: {
    key: "operator",
    label: "Operator",
    factColumn: "logonSessionId",
    dimTable: "StationLogonSession",
  },
  // Downtime reasons default; the scrap fact rebinds this to
  // "dispositionReasonId" (ItemDispositionReason — same shape, name column).
  reason: {
    key: "reason",
    label: "Reason",
    factColumn: "statusReasonId",
    dimTable: "StatusReason",
    labelColumn: "name",
  },
  // Product/Tool/Material display names live on their current versions — no
  // single labelColumn; the report compiler joins parent → currentVersion.
  product: { key: "product", label: "Product", factColumn: "productId", dimTable: "Product" },
  tool: { key: "tool", label: "Tool", factColumn: "toolId", dimTable: "Tool" },
  material: { key: "material", label: "Material", factColumn: "materialId", dimTable: "Material" },
};

// ── Measures ─────────────────────────────────────────────────────

// Bucket additive measures, in the exact order of the published
// ADDITIVE_KPI_KEYS constant — index.ts derives it from this list.
const BUCKET_ADDITIVE_DEFS = [
  { key: "totalCycles", label: "Total Cycles", unit: "count" },
  { key: "badCycles", label: "Bad Cycles", unit: "count" },
  { key: "totalItems", label: "Total Items", unit: "count" },
  { key: "badItems", label: "Bad Items", unit: "count" },
  { key: "expectedCycles", label: "Expected Cycles", unit: "count" },
  { key: "expectedItems", label: "Expected Items", unit: "count" },
  { key: "runSeconds", label: "Run Seconds", unit: "seconds" },
  { key: "downSeconds", label: "Down Seconds", unit: "seconds" },
  { key: "plannedDownSeconds", label: "Planned Down Seconds", unit: "seconds" },
  { key: "unplannedDownSeconds", label: "Unplanned Down Seconds", unit: "seconds" },
  { key: "idealCycleSeconds", label: "Ideal Cycle Seconds", unit: "seconds" },
  { key: "totalCycleSeconds", label: "Total Cycle Seconds", unit: "seconds" },
  { key: "elapsedExpectedCycles", label: "Elapsed Expected Cycles", unit: "count" },
  { key: "elapsedExpectedItems", label: "Elapsed Expected Items", unit: "count" },
  { key: "elapsedPlannedProductionSeconds", label: "Elapsed Planned Production Seconds", unit: "seconds" },
] as const satisfies readonly { key: string; label: string; unit: MeasureUnit }[];

export type BucketAdditiveKey = (typeof BUCKET_ADDITIVE_DEFS)[number]["key"];

/** Bucket additive measure keys, in publication order (= ADDITIVE_KPI_KEYS). */
export const BUCKET_ADDITIVE_KEYS: readonly BucketAdditiveKey[] = BUCKET_ADDITIVE_DEFS.map((d) => d.key);

// AST shorthands (local — the catalog is the only builder).
const f = (key: string): FormulaNode => ({ kind: "field", key });
const sub = (left: FormulaNode, right: FormulaNode): FormulaNode => ({ kind: "sub", left, right });
const mul = (left: FormulaNode, right: FormulaNode): FormulaNode => ({ kind: "mul", left, right });
const div = (left: FormulaNode, right: FormulaNode): FormulaNode => ({ kind: "div", left, right });

// OEE-family ratios. Formulas and guards mirror the MetricBucket generated
// columns (and index.ts computeAvailability/Performance/Quality/Oee) exactly.
const RATIO_MEASURES: MeasureDefinition[] = [
  {
    key: "availability",
    label: "Availability",
    unit: "ratio",
    kind: "ratio",
    deps: ["runSeconds", "elapsedPlannedProductionSeconds"],
    formula: div(f("runSeconds"), f("elapsedPlannedProductionSeconds")),
    guards: { nullWhenZero: "elapsedPlannedProductionSeconds" },
  },
  {
    key: "performance",
    label: "Performance",
    unit: "ratio",
    kind: "ratio",
    deps: ["idealCycleSeconds", "runSeconds", "elapsedPlannedProductionSeconds"],
    formula: div(f("idealCycleSeconds"), f("runSeconds")),
    guards: { nullWhenZero: "elapsedPlannedProductionSeconds", zeroWhenZero: "runSeconds" },
  },
  {
    key: "quality",
    label: "Quality",
    unit: "ratio",
    kind: "ratio",
    deps: ["totalItems", "badItems", "elapsedPlannedProductionSeconds"],
    formula: div(sub(f("totalItems"), f("badItems")), f("totalItems")),
    guards: { nullWhenZero: "elapsedPlannedProductionSeconds", zeroWhenZero: "totalItems" },
  },
  {
    key: "oee",
    label: "OEE",
    unit: "ratio",
    kind: "ratio",
    deps: ["idealCycleSeconds", "totalItems", "badItems", "elapsedPlannedProductionSeconds"],
    formula: div(
      mul(f("idealCycleSeconds"), sub(f("totalItems"), f("badItems"))),
      mul(f("elapsedPlannedProductionSeconds"), f("totalItems")),
    ),
    guards: { nullWhenZero: "elapsedPlannedProductionSeconds", zeroWhenZero: "totalItems" },
  },
];

const ALL_MEASURES: MeasureDefinition[] = [
  // bucket fact: additive columns are stored pre-aggregated per bucket.
  ...BUCKET_ADDITIVE_DEFS.map(
    (d): MeasureDefinition => ({ key: d.key, label: d.label, unit: d.unit, kind: "additive", sql: `"${d.key}"` }),
  ),
  ...RATIO_MEASURES,
  // cycle fact
  { key: "cycleCount", label: "Cycle Count", unit: "count", kind: "additive", agg: "count" },
  {
    key: "cycleSeconds",
    label: "Cycle Seconds",
    unit: "seconds",
    kind: "additive",
    sql: `extract(epoch from ("end" - "start"))`,
  },
  { key: "rejectCount", label: "Reject Count", unit: "count", kind: "additive", sql: `"rejectNumber"` },
  // downtime fact: open periods (endTime null) count up to now.
  {
    key: "downtimeSeconds",
    label: "Downtime Seconds",
    unit: "seconds",
    kind: "additive",
    sql: `extract(epoch from (coalesce("endTime", now()) - "startTime"))`,
  },
  { key: "eventCount", label: "Event Count", unit: "count", kind: "additive", agg: "count" },
  // scrap fact
  { key: "scrapQty", label: "Scrap Quantity", unit: "count", kind: "additive", sql: `"quantity"` },
  { key: "scrapEventCount", label: "Scrap Event Count", unit: "count", kind: "additive", agg: "count" },
  // items fact
  { key: "itemCount", label: "Item Count", unit: "count", kind: "additive", agg: "count" },
  // materialUsage fact. quantity is in per-material canonical units — sums
  // across materials are dimensionally meaningless, hence requiresDimension.
  {
    key: "materialQuantity",
    label: "Material Quantity",
    unit: "weight",
    kind: "additive",
    sql: `"quantity"`,
    requiresDimension: "material",
  },
  { key: "materialItemCount", label: "Material Item Count", unit: "count", kind: "additive", sql: `"itemCount"` },
];

export const MEASURES: Record<string, MeasureDefinition> = Object.fromEntries(ALL_MEASURES.map((m) => [m.key, m]));

// ── Facts ────────────────────────────────────────────────────────

export const FACTS: Record<FactKey, FactDefinition> = {
  cycle: {
    key: "cycle",
    table: "Cycle",
    timeColumn: `"end"`,
    dimensions: ["station", "workcenter", "site", "shift", "businessDate", "job", "operator", "tool"],
    measures: ["cycleCount", "cycleSeconds", "rejectCount"],
  },
  downtime: {
    // StationStateLog carries no siteId — reach through Station for site
    // scoping. Rows are split at shift boundaries at write time, so the
    // stamped shift/businessDate columns are exact for stamped rows.
    key: "downtime",
    table: "StationStateLog",
    timeColumn: `"startTime"`,
    dimensions: ["station", "workcenter", "shift", "businessDate", "job", "reason"],
    dimensionColumns: { job: "jobVersionId" },
    measures: ["downtimeSeconds", "eventCount"],
  },
  scrap: {
    key: "scrap",
    table: "ItemDispositionLog",
    // occurredAt is when the scrap happened; createdAt is when it was
    // recorded (backfill = createdAt) — see inventory.prisma.
    timeColumn: `coalesce("occurredAt", "createdAt")`,
    dimensions: [
      "station",
      "workcenter",
      "site",
      "shift",
      "businessDate",
      "job",
      "operator",
      "reason",
      "product",
      "tool",
    ],
    dimensionColumns: { reason: "dispositionReasonId" },
    measures: ["scrapQty", "scrapEventCount"],
  },
  items: {
    // Grain: one produced item (child of a Cycle, context copied from it).
    // Pairs with the scrap fact for good-vs-bad by product/mold/shift.
    key: "items",
    table: "InventoryItem",
    timeColumn: `coalesce("producedAt", "createdAt")`,
    dimensions: ["station", "workcenter", "site", "shift", "businessDate", "job", "operator", "product", "tool"],
    measures: ["itemCount"],
  },
  materialUsage: {
    // Grain: one accumulating usage row per (shift, station, job, product,
    // material) — see MaterialShiftUsage's unique key. No deletedAt column.
    key: "materialUsage",
    table: "MaterialShiftUsage",
    timeColumn: `"createdAt"`,
    dimensions: ["station", "workcenter", "site", "shift", "businessDate", "job", "product", "material"],
    measures: ["materialQuantity", "materialItemCount"],
    softDelete: false,
  },
  bucket: {
    // MetricBucket's entity is polymorphic (entityType + entityId). Report
    // queries pin entityType = 'STATION' (the compiler's job), which makes
    // entityId the station dimension. Workcenter/site rollup rows are
    // derived re-sums of station rows — reading STATION and re-summing is
    // always correct and avoids double counting.
    key: "bucket",
    table: "MetricBucket",
    timeColumn: `"startTime"`,
    dimensions: ["station", "site", "shift", "businessDate"],
    dimensionColumns: { station: "entityId" },
    measures: [...BUCKET_ADDITIVE_KEYS, ...RATIO_MEASURES.map((m) => m.key)],
  },
};

// ── Lookups ──────────────────────────────────────────────────────

export function getDimension(key: string): DimensionDefinition {
  const d = DIMENSIONS[key];
  if (!d) throw new Error(`Unknown dimension "${key}"`);
  return d;
}

export function getMeasure(key: string): MeasureDefinition {
  const m = MEASURES[key];
  if (!m) throw new Error(`Unknown measure "${key}"`);
  return m;
}

export function getFact(key: FactKey): FactDefinition {
  const fact = FACTS[key];
  if (!fact) throw new Error(`Unknown fact "${key}"`);
  return fact;
}

export function factMeasures(factKey: FactKey): MeasureDefinition[] {
  return getFact(factKey).measures.map(getMeasure);
}

export function factDimensions(factKey: FactKey): DimensionDefinition[] {
  return getFact(factKey).dimensions.map(getDimension);
}

// ── Evaluation ───────────────────────────────────────────────────

/**
 * Evaluate a ratio measure against pre-aggregated additive fields,
 * honoring its guards: nullWhenZero first, then zeroWhenZero, then the
 * formula. Both guards fire when their field is <= 0.
 */
export function evaluateRatioMeasure(measure: MeasureDefinition, fields: Record<string, number>): number | null {
  if (measure.kind !== "ratio" || !measure.formula) {
    throw new Error(`Measure "${measure.key}" is not a ratio measure`);
  }
  const guardValue = (key: string): number => {
    if (!(key in fields)) throw new Error(`evaluateRatioMeasure: missing field "${key}"`);
    return fields[key] as number;
  };
  const guards = measure.guards ?? {};
  if (guards.nullWhenZero !== undefined && guardValue(guards.nullWhenZero) <= 0) return null;
  if (guards.zeroWhenZero !== undefined && guardValue(guards.zeroWhenZero) <= 0) return 0;
  return evaluateFormula(measure.formula, fields);
}
