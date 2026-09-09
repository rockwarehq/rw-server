// Report catalog types — the semantic layer over the star-stamped fact tables.
//
// Two hard rules keep the catalog rollup-ready (a future pre-aggregation table
// can serve any query the base table can):
//   1. Measures are ADDITIVE ONLY: count, or sum/min/max over a row-local
//      expression. Ratios are declared as numerator/denominator over additive
//      measures and computed at read time — never sum a ratio.
//   2. All SQL fragments (exprs, joins, filters) are catalog-authored
//      constants, never user input. User-supplied values only ever bind as
//      query parameters in the compiler.

/** Additive measure, or a read-time ratio of two additive measures. */
export type MeasureDef =
  | { kind: "count"; label: string; description?: string }
  | {
      kind: "sum" | "min" | "max";
      label: string;
      /** Row-local SQL expression; reference fact columns as `f."col"`. */
      expr: string;
      description?: string;
    }
  | {
      kind: "ratio";
      label: string;
      /** Keys of additive measures on the same fact. */
      numerator: string;
      denominator: string;
      description?: string;
    };

export interface DimensionLookup {
  /**
   * LEFT JOIN clause(s) fetching the display name. `{a}` (and `{b}` for a
   * second hop) are replaced with per-dimension aliases by the compiler.
   */
  join: string;
  /** SQL expression for the display name, using the same alias tokens. */
  name: string;
}

export interface DimensionDef {
  label: string;
  /** Column on the fact table (compiler quotes it). */
  column: string;
  type: "id" | "date" | "enum" | "string";
  /** Joined only when the dimension is selected or name output is needed. */
  lookup?: DimensionLookup;
  enumValues?: readonly string[];
}

export interface FactDef {
  label: string;
  description?: string;
  /** Unquoted table name the fact reads from. */
  table: string;
  /** Row predicate applied to every query (soft deletes etc.); references `f`. */
  baseFilter?: string;
  /** businessDate stamp column — target of the date-range filter. */
  dateColumn: string;
  /**
   * Workcenter stamp column for workcenter-grant narrowing; null for
   * site-level facts with no workcenter dimension.
   */
  workcenterColumn: string | null;
  measures: Record<string, MeasureDef>;
  dimensions: Record<string, DimensionDef>;
}

export interface ReportFilter {
  dimension: string;
  op: "eq" | "neq" | "in";
  value: string | string[];
}

export interface ReportQuery {
  fact: string;
  /** At least one; ratio measures pull in their components automatically. */
  measures: string[];
  dimensions: string[];
  filters?: ReportFilter[];
  /** Inclusive YYYY-MM-DD bounds on the fact's businessDate stamp. */
  dateFrom?: string;
  dateTo?: string;
  /** A selected dimension key or measure key. */
  orderBy?: { field: string; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

/** Authz scope — injected by the rpc layer, never from the client. */
export interface ReportScope {
  siteId: string;
  /** Workcenter grant narrowing; undefined = unrestricted. */
  workcenterIds?: string[];
}

/** One result row: dimension keys (+ `<key>Name` for id dims) and measure keys. */
export type ReportRow = Record<string, string | number | null>;

export interface ReportResult {
  rows: ReportRow[];
  /** True when the row count hit the query limit. */
  truncated: boolean;
}
