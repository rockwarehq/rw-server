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
//
// The rollup guarantee covers AGGREGATE queries (ReportQuery) only. Detail
// queries (ReportRowsQuery) return the rows themselves, which no
// pre-aggregation table can serve, so they always read the base table. That
// exemption is deliberate: do not "fix" it by summarising detail output, and
// do not assume a future rollup can serve every query in this module.
//
// Detail mode gets its projections almost free from rule 1: an additive
// measure's expr is row-local by construction, so dropping the aggregate
// wrapper yields that row's own value.

/**
 * How a number should be read, so clients render it without hardcoding a list.
 * Not derivable from `kind`: avgCycleSeconds is a ratio measured in seconds
 * while OEE is a ratio measured in percent.
 */
export type ValueFormat = "seconds" | "percent" | "quantity" | "count" | "text";

/**
 * Words that help people and the AI find the right thing. None of it reaches
 * SQL. `synonyms` are other names people use ("scrap" for dispositions).
 * `aiHint` is advice for the AI only: when to pick this, and what to watch out
 * for.
 */
export interface CatalogText {
  description?: string;
  synonyms?: readonly string[];
  aiHint?: string;
}

/** What every measure carries, whatever its kind. */
interface MeasureBase extends CatalogText {
  label: string;
  format?: ValueFormat;
  /**
   * Dimensions that must be grouped by, or pinned to one value, whenever this
   * measure is asked for. Material quantity needs `unit`, because kilograms
   * and pounds must never be added together.
   */
  requiresDimensions?: readonly string[];
}

/** Additive measure, or a read-time ratio of two additive measures. */
export type MeasureDef =
  | (MeasureBase & { kind: "count" })
  | (MeasureBase & {
      kind: "sum" | "min" | "max" | "avg";
      /** Row-local SQL expression; reference fact columns as `f."col"`. */
      expr: string;
    })
  | (MeasureBase & {
      kind: "ratio";
      /**
       * Keys of additive measures on the same fact. Arrays multiply their
       * aggregated sums, so OEE-style products of ratios stay ratio-of-sums:
       * OEE = [ideal, good] / [elapsedPlanned, total].
       */
      numerator: string | string[];
      denominator: string | string[];
    });

/**
 * A named, ready-made filter, like "unplanned downtime". The SQL is written
 * here in the catalog, never sent by a caller; a query only names the key.
 */
export interface SegmentDef extends CatalogText {
  label: string;
  /** Row predicate; reference fact columns as `f."col"`. */
  filter: string;
}

export interface DimensionLookup {
  /**
   * LEFT JOIN clause(s) fetching the display name. `{a}` (and `{b}` for a
   * second hop) are replaced with per-dimension aliases by the compiler.
   */
  join: string;
  /** SQL expression for the display name, using the same alias tokens. */
  name: string;
}

/**
 * A row-local column, projected only by detail queries (`report.rows`).
 *
 * Fields are the columns that are neither a grouping key nor a measure — event
 * timestamps, the row's own id — so they never widen the grouping vocabulary.
 * `type` decides how the value reaches the wire, since every ReportRow value is
 * string | number | null:
 *   timestamp → UTC ISO string (client converts to the site zone)
 *   decimal   → exact numeric string, lossless (parse at the chart boundary)
 *   number    → float8
 *   boolean   → 'true' | 'false'
 */
export interface FieldDef {
  label: string;
  /** Column on the fact table/source (compiler quotes it). */
  column: string;
  type: "timestamp" | "decimal" | "number" | "string" | "id" | "boolean";
  description?: string;
  format?: ValueFormat;
}

export interface DimensionDef extends CatalogText {
  label: string;
  /**
   * Column on the fact table (compiler quotes it). Also the filter target and
   * the GROUP BY key, unless `expr` overrides it.
   */
  column: string;
  /**
   * SQL expression to use instead of the plain column — for a value the fact
   * carries but not as its own column, e.g. the workcenter inside a metric
   * bucket's `path`. Referenced as `f."col"` otherwise.
   */
  expr?: string;
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
  /**
   * The implicit m2m table joining this entity to Label, enabling hasLabel
   * filters. Prisma names those tables by ordering the two sides
   * alphabetically, so which column holds the label flips per entity
   * (_JobToLabel has it in B, _LabelToStation in A) — state it rather than
   * derive it. The entity id is in the other column.
   */
  labelJoin?: { table: string; labelColumn: "A" | "B" };
}

export interface FactDef extends CatalogText {
  label: string;
  /** Sample questions this fact answers, for the AI and for suggestions. */
  examples?: readonly string[];
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
  /**
   * Extra predicate applied to AGGREGATE queries only. For grain rules that are
   * true of a total but wrong for a list: cycles count when they END, so an
   * open cycle has no date to bucket into — yet a cycle log must still show the
   * one that is running. References `f`.
   */
  aggregateFilter?: string;
  /**
   * Row identity, used as the detail ORDER BY tie-break so OFFSET paging can't
   * skip or repeat rows across pages. Detail queries are refused without it.
   */
  rowKey?: string;
  /** Row-local columns available to detail queries only. */
  fields?: Record<string, FieldDef>;
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
  /** Named filters a query can switch on by key. */
  segments?: Record<string, SegmentDef>;
  measures: Record<string, MeasureDef>;
  dimensions: Record<string, DimensionDef>;
}

/**
 * Comparison operators. Each target type declares which of these it accepts
 * (see filters.ts) — ordering a uuid or substring-matching a date is refused
 * rather than silently coerced.
 */
export type FilterOp =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "notBetween"
  | "contains"
  | "beginsWith"
  | "isNull"
  | "notNull"
  // Carries at least one of the given labels — available on dimensions whose
  // entity is labelable. Value is a list of label ids.
  | "hasLabel"
  | "notHasLabel";

export interface ReportFilter {
  /**
   * The key to filter on: a dimension, a dimension's `<key>Name` display value,
   * a field, or a measure — resolved in that order. A measure filter becomes
   * HAVING in aggregate mode and a row predicate in detail mode. (Named
   * `dimension` for wire compatibility.)
   *
   * Filtering `<key>Name` is how you match on a name rather than a uuid:
   * "reason contains mold". The compiler joins the dimension's lookup for the
   * filter whether or not the column is selected.
   */
  dimension: string;
  op: FilterOp;
  /**
   * One value, or two for between/notBetween, or many for in/notIn. Omitted
   * for isNull/notNull.
   */
  value?: string | string[];
}

export interface ReportQuery {
  fact: string;
  /** At least one; ratio measures pull in their components automatically. */
  measures: string[];
  dimensions: string[];
  filters?: ReportFilter[];
  /** Segment keys; every one must match (they are ANDed). */
  segments?: string[];
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
  /**
   * Total number of GROUPS matching the query, for page counts. Costs a second
   * pass over the same aggregate, so leave it off for charts and exports.
   */
  includeTotal?: boolean;
}

/**
 * A detail query: the rows themselves, no grouping and no aggregation.
 *
 * Deliberately outside the rollup invariant stated at the top of this file — a
 * pre-aggregation table can never serve a detail query, so these always read
 * the base table. Aggregate queries keep the guarantee; this one opts out.
 */
export interface ReportRowsQuery {
  fact: string;
  /**
   * Output columns, in the order the caller wants them: dimension keys (an id
   * dimension also yields `<key>Name`), field keys, or measure keys — a measure
   * projects its row-local expression unaggregated. At least one.
   */
  columns: string[];
  filters?: ReportFilter[];
  /** Segment keys; every one must match (they are ANDed). */
  segments?: string[];
  /** Inclusive YYYY-MM-DD bounds on the fact's businessDate stamp. */
  dateFrom?: string;
  dateTo?: string;
  /** A selected column key; defaults to the fact's event timestamp, newest first. */
  orderBy?: { field: string; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
  /**
   * Total matching rows, for page counts. Costs a second COUNT over the same
   * predicate, so exports taking every row should turn it off. Default true.
   */
  includeTotal?: boolean;
}

export interface ReportRowsResult {
  rows: ReportRow[];
  /** True when the row count hit the query limit. */
  truncated: boolean;
  /** Present when includeTotal was not disabled. */
  total?: number;
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
  /** Present when includeTotal was requested: how many groups matched. */
  total?: number;
}
