import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { FACTS } from "./facts.js";
import { compileFilter, dimSql } from "./filters.js";
import type {
  FactDef,
  FieldDef,
  MeasureDef,
  ReportFilter,
  ReportQuery,
  ReportResult,
  ReportRow,
  ReportRowsQuery,
  ReportRowsResult,
  ReportScope,
  ReportSummaryItem,
  ReportSummaryQuery,
  ReportSummaryResult,
} from "./types.js";

// Compiles a catalog query into one parameterized statement: a GROUP BY for
// aggregates, or a plain projection for detail rows. Both share every
// predicate — scope, base filter, date bounds, user filters, fact defaults —
// so the two modes can never disagree about which rows exist.
//
// Trust boundary: table names, columns, measure exprs, and lookup joins come
// exclusively from the catalog (Prisma.raw); everything user-supplied — filter
// values, date bounds, scope ids — binds as query parameters. Measure,
// dimension and field KEYS from the client are only ever used to index into
// the catalog, never interpolated.

type ServiceError = { error: string; code: string };

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

// Detail rows are far wider than grouped rows, so the interactive default is a
// grid page. The ceiling stays high for exports, which ask for it explicitly.
const DETAIL_DEFAULT_LIMIT = 100;
const DETAIL_MAX_LIMIT = 10000;

const clampLimit = (limit: number | undefined) => Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

const clampDetailLimit = (limit: number | undefined) =>
  Math.min(Math.max(limit ?? DETAIL_DEFAULT_LIMIT, 1), DETAIL_MAX_LIMIT);

/** Alias of the joined Site row that date buckets read their calendar from. */
const SITE = "site";

const isValidDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

/** COUNT(*)/SUM(expr)/AVG(expr)/... for a non-ratio measure (ratio handled by the caller). */
function aggSql(measure: Exclude<MeasureDef, { kind: "ratio" }>): string {
  if (measure.kind === "count") return "COUNT(*)";
  return `${measure.kind.toUpperCase()}(${measure.expr})`;
}

/** Product of aggregated additive components, e.g. `(SUM(a))::float8 * (SUM(b))::float8`. */
function ratioSide(fact: FactDef, keys: string | string[]): string | ServiceError {
  const parts: string[] = [];
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const component = fact.measures[key];
    if (!component || component.kind === "ratio" || component.kind === "avg") {
      return { error: `Ratio component must be an additive measure: ${key}`, code: "INVALID_MEASURE" };
    }
    parts.push(`(${aggSql(component)})::float8`);
  }
  if (parts.length === 0) return { error: "Ratio side has no components", code: "INVALID_MEASURE" };
  return parts.join(" * ");
}

/** A measure's aggregate expression, without the output alias. */
function measureExpr(fact: FactDef, key: string): string | ServiceError {
  const measure = fact.measures[key];
  if (!measure) return { error: `Unknown measure: ${key}`, code: "UNKNOWN_MEASURE" };
  if (measure.kind !== "ratio") return `(${aggSql(measure)})::float8`;
  const num = ratioSide(fact, measure.numerator);
  if (typeof num !== "string") return num;
  const den = ratioSide(fact, measure.denominator);
  if (typeof den !== "string") return den;
  return `${num} / NULLIF(${den}, 0)`;
}

function measureSelect(fact: FactDef, key: string): string | ServiceError {
  const expr = measureExpr(fact, key);
  if (typeof expr !== "string") return expr;
  return `${expr} AS "${key}"`;
}

/**
 * Every predicate both modes share, in order: authz scope, catalog base
 * filter, an optional mode-only filter, the date range, user filters, then the
 * fact's own defaults.
 *
 * `addressed` names the dimensions the query has already pinned, so a default
 * filter doesn't fight an explicit one. Aggregate mode also counts grouping as
 * pinning (separate rows can't double-count); detail mode doesn't, because
 * nothing is summed there — selecting a column is not a claim about scope.
 */
function buildWhere(
  fact: FactDef,
  query: { filters?: ReportFilter[]; dateFrom?: string; dateTo?: string },
  scope: ReportScope,
  opts: { addressed: Set<string>; extraFilter?: string; aggregated?: boolean },
): { where: Prisma.Sql[]; having: Prisma.Sql[]; joins: string[] } | ServiceError {
  const where: Prisma.Sql[] = [Prisma.sql`${Prisma.raw('f."siteId"')} = ${scope.siteId}::uuid`];
  const having: Prisma.Sql[] = [];
  // Lookup joins pulled in by name filters; projection adds its own separately.
  const joins: string[] = [];
  let aliasSeed = 0;
  // A measure filter compares the aggregated value in aggregate mode (HAVING)
  // and the row's own value in detail mode (WHERE).
  const filterOpts = opts.aggregated
    ? { mode: "aggregate" as const, resolveMeasure: (key: string) => measureExpr(fact, key) }
    : { mode: "detail" as const, resolveMeasure: (key: string) => rowMeasureExpr(fact, key) };

  if (scope.workcenterIds) {
    if (fact.workcenterColumn) {
      // Strict: NULL stamps (legacy rows pre-backfill, or stations outside any
      // workcenter) are NOT visible to workcenter-restricted principals.
      const wc = Prisma.raw(`f."${fact.workcenterColumn}"`);
      where.push(Prisma.sql`${wc} = ANY(${scope.workcenterIds}::uuid[])`);
    } else if (fact.workcenterPredicate) {
      const [before, after] = fact.workcenterPredicate.split("{ids}");
      where.push(Prisma.sql`${Prisma.raw(before)}${scope.workcenterIds}::uuid[]${Prisma.raw(after)}`);
    } else {
      return {
        error: "This fact cannot be narrowed to workcenter grants and requires site-wide access",
        code: "WORKCENTER_RESTRICTED",
      };
    }
  }

  if (fact.baseFilter) where.push(Prisma.sql`${Prisma.raw(fact.baseFilter)}`);
  if (opts.extraFilter) where.push(Prisma.sql`${Prisma.raw(opts.extraFilter)}`);

  const dateCol = Prisma.raw(`f."${fact.dateColumn}"`);
  for (const bound of [query.dateFrom, query.dateTo]) {
    if (bound !== undefined && !isValidDate(bound)) {
      return { error: `Invalid date bound: ${bound}`, code: "INVALID_QUERY" };
    }
  }
  if (query.dateFrom) where.push(Prisma.sql`${dateCol} >= ${query.dateFrom}::date`);
  if (query.dateTo) where.push(Prisma.sql`${dateCol} <= ${query.dateTo}::date`);

  const push = (filter: ReportFilter): ServiceError | undefined => {
    const resolved = compileFilter(fact, filter, { ...filterOpts, alias: String(aliasSeed++) });
    if ("error" in resolved) return resolved;
    (resolved.placement === "having" ? having : where).push(resolved.sql);
    if (resolved.join) joins.push(resolved.join);
    return undefined;
  };

  for (const filter of query.filters ?? []) {
    const failed = push(filter);
    if (failed) return failed;
  }

  for (const filter of fact.defaultFilters ?? []) {
    if (opts.addressed.has(filter.dimension)) continue;
    const failed = push(filter);
    if (failed) return failed;
  }

  return { where, having, joins };
}

/** Dimensions a query has pinned to a single value, so fact defaults stand down. */
function pinnedDimensions(filters: ReportFilter[] | undefined): string[] {
  return (filters ?? [])
    .filter((f) => f.op === "eq" || (f.op === "in" && Array.isArray(f.value) && f.value.length === 1))
    .map((f) => f.dimension);
}

/** The FROM clause: a catalog table, or a catalog-authored union subquery. */
function fromClause(fact: FactDef, key: string): string | ServiceError {
  if (fact.source) return `(${fact.source})`;
  if (fact.table) return `"${fact.table}"`;
  return { error: `Fact ${key} has neither table nor source`, code: "INVALID_FACT" };
}

/**
 * Compiles an aggregate query, plus the statement that counts how many groups
 * it has — the same page-count the detail mode returns, so a grouped log
 * paginates like a row log.
 */
function compileAggregate(
  query: ReportQuery,
  scope: ReportScope,
): { sql: Prisma.Sql; count: Prisma.Sql } | ServiceError {
  const fact = FACTS[query.fact];
  if (!fact) return { error: `Unknown fact: ${query.fact}`, code: "UNKNOWN_FACT" };
  if (query.measures.length === 0) return { error: "At least one measure is required", code: "INVALID_QUERY" };

  // ── SELECT: dimensions (id + name) and measures ──
  const selects: string[] = [];
  const groupBys: string[] = [];
  const joins: string[] = [];
  const outputKeys = new Set<string>();
  /** Per-dimension ORDER BY expression: MIN(sortExpr) when declared, else the output alias. */
  const dimOrderExprs = new Map<string, string>();

  const granularity = query.dateGranularity ?? "day";
  if (granularity === "hour" && !fact.timeColumn) {
    return { error: `Fact ${query.fact} has no event timestamp; hourly bucketing unavailable`, code: "INVALID_QUERY" };
  }

  // The site row, joined once when a date bucket needs its calendar settings.
  let siteJoined = false;
  const joinSite = () => {
    if (siteJoined) return;
    siteJoined = true;
    joins.push(`JOIN "Site" ${SITE} ON ${SITE}."id" = f."siteId"`);
  };
  let dateSortExpr: string | undefined;

  for (const [i, key] of query.dimensions.entries()) {
    const dim = fact.dimensions[key];
    if (!dim) return { error: `Unknown dimension: ${key}`, code: "UNKNOWN_DIMENSION" };
    const col = dimSql(dim);
    if (dim.type === "date") {
      // Date bucketing: day/week/month/year truncate businessDate — a plain
      // DATE already derived from the shift schedule at write time, so this is
      // pure calendar math with no timezone anywhere. Buckets come back as
      // 'YYYY-MM-DD' strings; clients must render them verbatim, never parse
      // them as instants (new Date("YYYY-MM-DD") is UTC midnight and shifts a
      // day in negative-offset zones).
      //
      // Week starts on the site's weekStart: a bucket is named by its first
      // date, found by stepping back to the last start weekday (ISO dow:
      // Monday 1 … Sunday 7). It only groups dates; a row's businessDate is
      // never touched by it.
      //
      // Hour stays inside the business date: rows group by businessDate AND
      // the site-local hour of their event time, so a business date's hours
      // always sum to its day — a night shift's hours before midnight belong
      // to the day they were worked for. The bucket is the local wall-clock
      // hour 'YYYY-MM-DDTHH:00' (no zone — render verbatim, like a date),
      // with the business date it belongs to alongside as `<key>BusinessDate`.
      let expr: string;
      if (granularity === "hour" || granularity === "week") joinSite();
      if (granularity === "hour") {
        const local = `date_trunc('hour', f."${fact.timeColumn}" AT TIME ZONE ${SITE}."timezone")`;
        expr = `to_char(${local}, 'YYYY-MM-DD"T"HH24:00')`;
        const businessDate = `to_char(${col}, 'YYYY-MM-DD')`;
        selects.push(`${businessDate} AS "${key}BusinessDate"`);
        groupBys.push(businessDate);
        outputKeys.add(`${key}BusinessDate`);
        // Real time order, so a repeated DST hour and a business day that
        // opens the evening before both sort as worked.
        dateSortExpr = `MIN(f."${fact.timeColumn}")`;
      } else if (granularity === "week") {
        const startDow = `CASE ${SITE}."weekStart" WHEN 'SUNDAY' THEN 7 ELSE 1 END`;
        expr = `to_char(${col} - ((EXTRACT(ISODOW FROM ${col})::int - ${startDow} + 7) % 7), 'YYYY-MM-DD')`;
      } else if (granularity === "day") {
        expr = `to_char(${col}, 'YYYY-MM-DD')`;
      } else {
        expr = `to_char(date_trunc('${granularity}', ${col}), 'YYYY-MM-DD')`;
      }
      selects.push(`${expr} AS "${key}"`);
      groupBys.push(expr);
    } else {
      // enum dimensions render as text: some sit on a boolean column
      // (isScheduled), and a raw boolean would break the string|number|null
      // wire contract. Filters already compare ::text, so this matches.
      const expr = dim.type === "enum" ? `${col}::text` : col;
      selects.push(`${expr} AS "${key}"`);
      groupBys.push(expr);
    }
    outputKeys.add(key);
    dimOrderExprs.set(
      key,
      dim.type === "date" && dateSortExpr
        ? dateSortExpr
        : dim.sortExpr
          ? `MIN(${dim.sortExpr.replaceAll("{a}", `d${i}`).replaceAll("{b}", `d${i}b`)})`
          : `"${key}"`,
    );
    if (dim.lookup) {
      const name = dim.lookup.name.replaceAll("{a}", `d${i}`).replaceAll("{b}", `d${i}b`);
      joins.push(dim.lookup.join.replaceAll("{a}", `d${i}`).replaceAll("{b}", `d${i}b`));
      selects.push(`${name} AS "${key}Name"`);
      groupBys.push(name);
      outputKeys.add(`${key}Name`);
    } else if (dim.nameColumn) {
      selects.push(`f."${dim.nameColumn}" AS "${key}Name"`);
      groupBys.push(`f."${dim.nameColumn}"`);
      outputKeys.add(`${key}Name`);
    }
  }

  for (const key of query.measures) {
    const select = measureSelect(fact, key);
    if (typeof select !== "string") return select;
    selects.push(select);
    outputKeys.add(key);
  }

  // ── WHERE/HAVING: shared with detail mode; grouping also pins a fact default ──
  const predicates = buildWhere(fact, query, scope, {
    addressed: new Set([...query.dimensions, ...pinnedDimensions(query.filters)]),
    extraFilter: fact.aggregateFilter,
    aggregated: true,
  });
  if ("error" in predicates) return predicates;
  // A measure filter compares the aggregated value, so it lands in HAVING —
  // `scrap > 100` means the group's total, not any one row's.
  const having =
    predicates.having.length > 0 ? Prisma.sql` HAVING ${Prisma.join(predicates.having, " AND ")}` : Prisma.empty;

  // ── ORDER BY a selected output key; default: first dimension, else first measure ──
  // A dimension with a sortExpr orders by that key (e.g. shifts by start time,
  // not name). The remaining selected dimensions follow as ascending
  // tie-breakers so grouped rows come back in a deterministic order.
  const orderKey = query.orderBy?.field ?? query.dimensions[0] ?? query.measures[0];
  if (!outputKeys.has(orderKey)) {
    return { error: `orderBy field must be a selected dimension or measure: ${orderKey}`, code: "INVALID_QUERY" };
  }
  const orderDir = query.orderBy?.dir === "desc" ? "DESC" : "ASC";
  const orderParts = [`${dimOrderExprs.get(orderKey) ?? `"${orderKey}"`} ${orderDir} NULLS LAST`];
  for (const key of query.dimensions) {
    if (key !== orderKey) orderParts.push(`${dimOrderExprs.get(key)} ASC NULLS LAST`);
  }

  const limit = clampLimit(query.limit);
  const offset = Math.max(query.offset ?? 0, 0);

  const from = fromClause(fact, query.fact);
  if (typeof from !== "string") return from;

  // Name filters bring their own lookup joins; the projection's come first.
  const allJoins = Prisma.raw([...joins, ...predicates.joins].join(" "));
  const grouping = Prisma.raw(groupBys.length > 0 ? `GROUP BY ${groupBys.join(", ")}` : "");
  const predicate = Prisma.join(predicates.where, " AND ");

  return {
    sql: Prisma.sql`
      SELECT ${Prisma.raw(selects.join(", "))}
      FROM ${Prisma.raw(from)} f
      ${allJoins}
      WHERE ${predicate}
      ${grouping}${having}
      ORDER BY ${Prisma.raw(orderParts.join(", "))}
      LIMIT ${limit + 1} OFFSET ${offset}
    `,
    // Counting groups means counting the rows of the grouped set, so the
    // grouping has to run first — hence the subquery.
    count: Prisma.sql`
      SELECT COUNT(*)::bigint AS "total" FROM (
        SELECT ${Prisma.raw(groupBys.length > 0 ? groupBys.join(", ") : "1")}
        FROM ${Prisma.raw(from)} f
        ${allJoins}
        WHERE ${predicate}
        ${grouping}${having}
      ) g
    `,
  };
}

export function compileReportQuery(query: ReportQuery, scope: ReportScope): Prisma.Sql | ServiceError {
  const compiled = compileAggregate(query, scope);
  return "error" in compiled ? compiled : compiled.sql;
}

export async function runReportQuery(query: ReportQuery, scope: ReportScope): Promise<ReportResult | ServiceError> {
  const compiled = compileAggregate(query, scope);
  if ("error" in compiled) return compiled;
  const limit = clampLimit(query.limit);

  const [rows, totals] = await Promise.all([
    prisma.$queryRaw<ReportRow[]>(compiled.sql),
    query.includeTotal ? prisma.$queryRaw<{ total: bigint }[]>(compiled.count) : Promise.resolve(undefined),
  ]);

  return {
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    ...(totals ? { total: Number(totals[0]?.total ?? 0) } : {}),
  };
}

// ── Detail mode: the rows themselves ────────────────────────────────────────

/** A field's projection, cast to whatever keeps it string | number | null. */
function fieldSelect(field: FieldDef): string {
  const col = `f."${field.column}"`;
  switch (field.type) {
    case "timestamp":
      // UTC ISO with milliseconds; the client converts to the site zone. Fixed
      // width, so ordering the rendered string matches ordering the instant.
      return `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case "decimal":
      // Exact. Quantities and weights must not round-trip through float8;
      // callers parse at the chart boundary, where precision is pixels.
      return `${col}::text`;
    case "number":
      return `${col}::float8`;
    case "boolean":
      return `${col}::text`;
    default:
      return col;
  }
}

/** Product of row-local component exprs, for a ratio evaluated per row. */
function rowRatioSide(fact: FactDef, keys: string | string[]): string | ServiceError {
  const parts: string[] = [];
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const component = fact.measures[key];
    if (!component || component.kind === "ratio" || component.kind === "count") {
      return { error: `Ratio component must be a row-local measure: ${key}`, code: "INVALID_MEASURE" };
    }
    parts.push(`(${component.expr})::float8`);
  }
  if (parts.length === 0) return { error: "Ratio side has no components", code: "INVALID_MEASURE" };
  return parts.join(" * ");
}

/**
 * A measure's value for one row: the same expression, minus the aggregate
 * wrapper. Rule 1 (additive measures are row-local exprs) is what makes this
 * safe. COUNT has no row-local meaning and is refused.
 */
function rowMeasureExpr(fact: FactDef, key: string): string | ServiceError {
  const measure = fact.measures[key];
  if (!measure) return { error: `Unknown measure: ${key}`, code: "UNKNOWN_MEASURE" };
  if (measure.kind === "count") {
    return { error: `Measure ${key} counts rows and has no per-row value`, code: "INVALID_MEASURE" };
  }
  if (measure.kind !== "ratio") return `(${measure.expr})::float8`;
  const num = rowRatioSide(fact, measure.numerator);
  if (typeof num !== "string") return num;
  const den = rowRatioSide(fact, measure.denominator);
  if (typeof den !== "string") return den;
  return `${num} / NULLIF(${den}, 0)`;
}

/**
 * Compiles a detail query into a projection plus a matching COUNT. The count
 * shares the predicate but skips the name-lookup joins, which exist only to
 * decorate output — filters never reference them.
 */
export function compileReportRows(
  query: ReportRowsQuery,
  scope: ReportScope,
): { sql: Prisma.Sql; count: Prisma.Sql } | ServiceError {
  const fact = FACTS[query.fact];
  if (!fact) return { error: `Unknown fact: ${query.fact}`, code: "UNKNOWN_FACT" };
  if (!fact.rowKey) {
    return { error: `Fact ${query.fact} does not expose detail rows`, code: "DETAIL_UNAVAILABLE" };
  }
  if (query.columns.length === 0) return { error: "At least one column is required", code: "INVALID_QUERY" };

  const selects: string[] = [];
  const joins: string[] = [];
  const outputKeys = new Set<string>();
  /** Output key → the expression to ORDER BY (the column, never the alias). */
  const orderExprs = new Map<string, string>();

  // Columns come back in the order asked for: default column sets belong to
  // each UI, so the catalog imposes no canonical order. A key that is both a
  // dimension and a field resolves as the dimension.
  for (const [i, key] of query.columns.entries()) {
    const dim = fact.dimensions[key];
    const field = fact.fields?.[key];
    const measure = fact.measures[key];

    if (dim) {
      const col = dimSql(dim);
      // businessDate stays a business-calendar string — no bucketing here, and
      // still rendered verbatim, never parsed as an instant.
      const expr = dim.type === "date" ? `to_char(${col}, 'YYYY-MM-DD')` : dim.type === "enum" ? `${col}::text` : col;
      selects.push(`${expr} AS "${key}"`);
      orderExprs.set(key, col);
      outputKeys.add(key);
      if (dim.lookup) {
        const name = dim.lookup.name.replaceAll("{a}", `d${i}`).replaceAll("{b}", `d${i}b`);
        joins.push(dim.lookup.join.replaceAll("{a}", `d${i}`).replaceAll("{b}", `d${i}b`));
        selects.push(`${name} AS "${key}Name"`);
        orderExprs.set(`${key}Name`, name);
        outputKeys.add(`${key}Name`);
      } else if (dim.nameColumn) {
        selects.push(`f."${dim.nameColumn}" AS "${key}Name"`);
        orderExprs.set(`${key}Name`, `f."${dim.nameColumn}"`);
        outputKeys.add(`${key}Name`);
      }
    } else if (field) {
      selects.push(`${fieldSelect(field)} AS "${key}"`);
      orderExprs.set(key, `f."${field.column}"`);
      outputKeys.add(key);
    } else if (measure) {
      const select = rowMeasureExpr(fact, key);
      if (typeof select !== "string") return select;
      selects.push(`${select} AS "${key}"`);
      orderExprs.set(key, select);
      outputKeys.add(key);
    } else {
      return { error: `Unknown column: ${key}`, code: "UNKNOWN_COLUMN" };
    }
  }

  // No grouping here, so only an explicit filter pins a fact default — and a
  // measure filter compares this row's own value, never a HAVING.
  const predicates = buildWhere(fact, query, scope, { addressed: new Set(pinnedDimensions(query.filters)) });
  if ("error" in predicates) return predicates;

  const orderParts: string[] = [];
  if (query.orderBy) {
    const expr = orderExprs.get(query.orderBy.field);
    if (!expr) {
      return { error: `orderBy field must be a selected column: ${query.orderBy.field}`, code: "INVALID_QUERY" };
    }
    orderParts.push(`${expr} ${query.orderBy.dir === "asc" ? "ASC" : "DESC"} NULLS LAST`);
  } else if (fact.timeColumn) {
    orderParts.push(`f."${fact.timeColumn}" DESC NULLS LAST`);
  }
  // Unique tie-break, always last. The key is a random uuid, so it carries no
  // meaning — it only has to be a total order, which is what keeps OFFSET
  // paging from skipping or repeating rows when the sort key has ties.
  orderParts.push(`f."${fact.rowKey}" DESC`);

  const limit = clampDetailLimit(query.limit);
  const offset = Math.max(query.offset ?? 0, 0);

  const from = fromClause(fact, query.fact);
  if (typeof from !== "string") return from;

  const predicate = Prisma.join(predicates.where, " AND ");
  // The count skips the display joins but still needs any a filter relies on.
  const filterJoins = Prisma.raw(predicates.joins.join(" "));
  return {
    sql: Prisma.sql`
      SELECT ${Prisma.raw(selects.join(", "))}
      FROM ${Prisma.raw(from)} f
      ${Prisma.raw([...joins, ...predicates.joins].join(" "))}
      WHERE ${predicate}
      ORDER BY ${Prisma.raw(orderParts.join(", "))}
      LIMIT ${limit + 1} OFFSET ${offset}
    `,
    count: Prisma.sql`
      SELECT COUNT(*)::bigint AS "total"
      FROM ${Prisma.raw(from)} f
      ${filterJoins}
      WHERE ${predicate}
    `,
  };
}

export async function runReportRows(
  query: ReportRowsQuery,
  scope: ReportScope,
): Promise<ReportRowsResult | ServiceError> {
  const compiled = compileReportRows(query, scope);
  if ("error" in compiled) return compiled;
  const limit = clampDetailLimit(query.limit);

  // The count runs in its own snapshot, so under concurrent writes it can
  // disagree with the page by a row. For logs that is noise, and it beats
  // dragging COUNT(*) OVER () through every wide row.
  const [rows, totals] = await Promise.all([
    prisma.$queryRaw<ReportRow[]>(compiled.sql),
    query.includeTotal === false ? Promise.resolve(undefined) : prisma.$queryRaw<{ total: bigint }[]>(compiled.count),
  ]);

  return {
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    ...(totals ? { total: Number(totals[0]?.total ?? 0) } : {}),
  };
}

// ── Summary: figures over every row a detail query matches ──────────────────

/** One summary item's aggregate expression, or why it can't be computed. */
function summaryExpr(fact: FactDef, item: ReportSummaryItem): string | ServiceError {
  const { key, agg } = item;
  // A count is the rows themselves, whatever any one column holds.
  if (agg === "count") return "COUNT(*)";
  if (key === undefined) return { error: `A ${agg} needs a column`, code: "INVALID_QUERY" };

  // Resolution mirrors the detail projection: dimension, then field, then
  // measure — the figure is over the column a log shows under this key.
  // Own entries only: a key like "toString" is on every object's prototype.
  const own = <T>(entries: Record<string, T> | undefined) =>
    entries && Object.hasOwn(entries, key) ? entries[key] : undefined;
  const field = own(fact.fields);
  const measure = own(fact.measures);
  const fn = agg.toUpperCase();

  if (own(fact.dimensions)) {
    return { error: `${key} is a dimension and can only be counted`, code: "INVALID_QUERY" };
  }
  if (field) {
    if (field.type !== "number" && field.type !== "decimal") {
      return { error: `${key} is not a number and can only be counted`, code: "INVALID_QUERY" };
    }
    return `${fn}(f."${field.column}")`;
  }
  if (!measure) return { error: `Unknown column: ${key}`, code: "UNKNOWN_COLUMN" };

  if (measure.kind === "count") {
    if (agg === "sum") return "COUNT(*)";
    return { error: `Measure ${key} counts rows and has no per-row value`, code: "INVALID_MEASURE" };
  }
  if (measure.kind === "ratio") {
    // Never sum a ratio, and never average per-row ratios: the average of a
    // ratio is the ratio of its summed components.
    if (agg === "sum") return { error: `Measure ${key} is a ratio and cannot be summed`, code: "INVALID_MEASURE" };
    if (agg === "avg") return measureExpr(fact, key);
  }
  const row = rowMeasureExpr(fact, key);
  if (typeof row !== "string") return row;
  return `${fn}(${row})`;
}

/**
 * Compiles a summary into one ungrouped aggregate over the detail predicate.
 * Outputs are aliased by position — item keys only ever index the catalog.
 */
export function compileReportSummary(query: ReportSummaryQuery, scope: ReportScope): Prisma.Sql | ServiceError {
  const fact = FACTS[query.fact];
  if (!fact) return { error: `Unknown fact: ${query.fact}`, code: "UNKNOWN_FACT" };
  if (!fact.rowKey) {
    return { error: `Fact ${query.fact} does not expose detail rows`, code: "DETAIL_UNAVAILABLE" };
  }
  if (query.items.length === 0) return { error: "At least one summary item is required", code: "INVALID_QUERY" };

  const selects: string[] = [];
  for (const [i, item] of query.items.entries()) {
    const expr = summaryExpr(fact, item);
    if (typeof expr !== "string") return expr;
    selects.push(`(${expr})::float8 AS "s${i}"`);
  }

  // The same predicate report.rows builds, so the figures are over the list.
  const predicates = buildWhere(fact, query, scope, { addressed: new Set(pinnedDimensions(query.filters)) });
  if ("error" in predicates) return predicates;

  const from = fromClause(fact, query.fact);
  if (typeof from !== "string") return from;

  return Prisma.sql`
    SELECT ${Prisma.raw(selects.join(", "))}
    FROM ${Prisma.raw(from)} f
    ${Prisma.raw(predicates.joins.join(" "))}
    WHERE ${Prisma.join(predicates.where, " AND ")}
  `;
}

export async function runReportSummary(
  query: ReportSummaryQuery,
  scope: ReportScope,
): Promise<ReportSummaryResult | ServiceError> {
  const compiled = compileReportSummary(query, scope);
  if ("error" in compiled) return compiled;
  const [row] = await prisma.$queryRaw<Record<string, number | null>[]>(compiled);
  return { values: query.items.map((_, i) => row?.[`s${i}`] ?? null) };
}
