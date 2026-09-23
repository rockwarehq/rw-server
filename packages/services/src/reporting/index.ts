import { FACTS } from "./facts.js";
import type { FactDef, MeasureDef, ReportFilter, ValueFormat } from "./types.js";

export { compileReportQuery, compileReportRows, runReportQuery, runReportRows } from "./compiler.js";
export { FACTS } from "./facts.js";
export type {
  FactDef,
  FieldDef,
  MeasureDef,
  DimensionDef,
  ReportFilter,
  ReportQuery,
  ReportResult,
  ReportRow,
  ReportRowsQuery,
  ReportRowsResult,
  ReportScope,
} from "./types.js";

/** Serializable measure metadata — SQL stays server-side. */
export interface MeasureSchema {
  key: string;
  label: string;
  kind: "count" | "sum" | "min" | "max" | "avg" | "ratio";
  description?: string;
  /**
   * Whether the measure has a value for a single row, so report.rows can show
   * it. COUNT doesn't, and nor does a ratio built on one — "good cycle rate"
   * is a property of a group, not of one cycle.
   */
  rowLocal: boolean;
  /** How to render the number — seconds and percentages aren't plain counts. */
  format: ValueFormat;
}

/** A measure with no declared format is a plain tally; a ratio is a percentage. */
const measureFormat = (measure: MeasureDef): ValueFormat =>
  measure.format ?? (measure.kind === "ratio" ? "percent" : "count");

/** Mirrors what the detail compiler will accept, so the schema can't promise more. */
function isRowLocal(fact: FactDef, measure: MeasureDef): boolean {
  if (measure.kind === "count") return false;
  if (measure.kind !== "ratio") return true;
  const components = [measure.numerator, measure.denominator].flatMap((side) => (Array.isArray(side) ? side : [side]));
  return components.every((key) => {
    const component = fact.measures[key];
    return component !== undefined && component.kind !== "count" && component.kind !== "ratio";
  });
}

export interface DimensionSchema {
  key: string;
  label: string;
  type: "id" | "date" | "enum" | "string";
  enumValues?: readonly string[];
  /** True when result rows include a `<key>Name` display column. */
  hasName: boolean;
  /** True when hasLabel/notHasLabel filters are available on this dimension. */
  hasLabels: boolean;
}

/**
 * A row-local column, available to report.rows only. Not a grouping key, so it
 * never appears in an aggregate query.
 */
export interface FieldSchema {
  key: string;
  label: string;
  type: "timestamp" | "decimal" | "number" | "string" | "id" | "boolean";
  description?: string;
  /** How to render the value; defaults by type when the field doesn't say. */
  format: ValueFormat;
}

export interface FactSchema {
  key: string;
  label: string;
  description?: string;
  /** Whether dateGranularity: "hour" is available (fact has an event timestamp). */
  supportsHourly: boolean;
  /** Whether report.rows can list this fact's rows (the fact declares a row key). */
  supportsDetail: boolean;
  /** Filters applied unless the query pins that dimension (UI should surface them). */
  defaultFilters: ReportFilter[];
  measures: MeasureSchema[];
  dimensions: DimensionSchema[];
  /**
   * Detail-only columns. Default column sets and their order belong to each
   * client — the catalog states what exists, not how to lay it out.
   */
  fields: FieldSchema[];
}

/**
 * The catalog as plain data for the report-builder UI: fact/measure/dimension
 * pickers render straight from this. No SQL crosses the wire.
 */
export function reportSchema(): FactSchema[] {
  return Object.entries(FACTS).map(([key, fact]) => ({
    key,
    label: fact.label,
    description: fact.description,
    supportsHourly: fact.timeColumn !== undefined,
    supportsDetail: fact.rowKey !== undefined,
    defaultFilters: fact.defaultFilters ?? [],
    measures: Object.entries(fact.measures).map(([mKey, m]) => ({
      key: mKey,
      label: m.label,
      kind: m.kind,
      description: m.description,
      rowLocal: isRowLocal(fact, m),
      format: measureFormat(m),
    })),
    dimensions: Object.entries(fact.dimensions).map(([dKey, d]) => ({
      key: dKey,
      label: d.label,
      type: d.type,
      enumValues: d.enumValues,
      hasName: d.lookup !== undefined || d.nameColumn !== undefined,
      hasLabels: d.labelJoin !== undefined,
    })),
    fields: Object.entries(fact.fields ?? {}).map(([fKey, f]) => ({
      key: fKey,
      label: f.label,
      type: f.type,
      description: f.description,
      format: f.format ?? (f.type === "decimal" || f.type === "number" ? "quantity" : "text"),
    })),
  }));
}
