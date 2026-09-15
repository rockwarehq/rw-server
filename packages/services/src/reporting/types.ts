// Report catalog types — the semantic layer over the star-stamped fact tables.
//
// Two hard rules keep the catalog rollup-ready (a future pre-aggregation table
// can serve any query the base table can):
//   1. Measures are ADDITIVE ONLY: count, or sum/min/max over a row-local
//      expression. Ratios are declared as numerator/denominator over additive
//      measures and computed at read time — never sum a ratio. avg is read-time
//      sugar for sum/count (a rollup serves it from the stored pair), so it may
//      not appear inside a ratio.
//   2. All SQL fragments (exprs, joins, filters) are catalog-authored
//      constants, never user input. User-supplied values only ever bind as
//      query parameters in the compiler.

/** Additive measure, or a read-time ratio of two additive measures. */
export type MeasureDef =
  | { kind: "count"; label: string; description?: string }
  | {
      kind: "sum" | "min" | "max" | "avg";
      label: string;
      /** Row-local SQL expression; reference fact columns as `f."col"`. */
      expr: string;
      description?: string;
    }
  | {
      kind: "ratio";
      label: string;
      /**
       * Keys of additive measures on the same fact. Arrays multiply their
       * aggregated sums, so OEE-style products of ratios stay ratio-of-sums:
       * OEE = [ideal, good] / [elapsedPlanned, total].
       */
      numerator: string | string[];
      denominator: string | string[];
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
  /**
   * Row-local column holding the display name — for ids that can't be joined
   * (e.g. MetricBucket JOB entityIds are synthetic hashes; entityName is the
   * only label). Mutually exclusive with lookup.
   */
  nameColumn?: string;
  enumValues?: readonly string[];
  /**
   * SQL expression ordering this dimension by something
   * other than its value — e.g. shift instances by start time, so a night
   * shift that opens the business day sorts first regardless of name. 
   */
  sortExpr?: string;
}

export interface FactDef {
  label: string;
  description?: string;
  /**
   * The read permission gating this fact, mirroring the sibling rpc routers
   * that expose the same tables (job:read, product:read, employee:read,
   * calls:read). Enforced by the report rpc layer.
   */
  permission: string;
  /** Unquoted table name the fact reads from. Exactly one of table/source. */
  table?: string;
  /**
   * Catalog-authored SQL subquery to read from instead of `table` — for
   * consolidated facts (UNION ALL sources). Must project every column the
   * fact's measures/dimensions/filters reference.
   */
  source?: string;
  /** Row predicate applied to every query (soft deletes etc.); references `f`. */
  baseFilter?: string;
  /** businessDate stamp column — target of the date-range filter. */
  dateColumn: string;
  /**
   * Event timestamp column enabling sub-day date bucketing (hour). Facts
   * without one don't offer hourly granularity.
   */
  timeColumn?: string;
  /**
   * Workcenter stamp column for workcenter-grant narrowing (strict: rows with
   * a NULL stamp are NOT visible to workcenter-restricted principals — until
   * the backfill runs, NULL means "legacy row of unknown workcenter").
   */
  workcenterColumn: string | null;
  /**
   * Alternative narrowing predicate for facts without a workcenter stamp
   * (e.g. KPI facts narrow via the station's workcenter). `{ids}` is replaced
   * with the granted workcenter-id array parameter. Facts with neither this
   * nor workcenterColumn refuse workcenter-restricted queries outright.
   */
  workcenterPredicate?: string;
  /**
   * Filters applied unless the query filters or groups by that dimension
   * itself — e.g. KPI facts default to granularity = SHIFT so bucket
   * granularities never sum together by accident.
   */
  defaultFilters?: ReportFilter[];
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
  /**
   * Bucket size for the fact's date dimension when it is selected. day (the
   * default), week, month, and year truncate businessDate; hour truncates the
   * fact's event timestamp (UTC-pinned) and requires the fact to declare a
   * timeColumn.
   *
   * Client contract: day/week/month/year buckets are business-calendar
   * 'YYYY-MM-DD' strings — render verbatim, never parse as instants. Hour
   * buckets are UTC ISO timestamps — convert to the site zone for display.
   * The two grains deliberately disagree at midnight: a night shift's rows
   * share one businessDate while their hours span two calendar dates, so 24
   * hourly buckets need not sum to a businessDate day total.
   */
  dateGranularity?: "hour" | "day" | "week" | "month" | "year";
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
