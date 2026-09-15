import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { FACTS } from "./facts.js";
import type { DimensionDef, FactDef, MeasureDef, ReportQuery, ReportResult, ReportRow, ReportScope } from "./types.js";

// Compiles a catalog query into one parameterized GROUP BY statement.
//
// Trust boundary: table names, columns, measure exprs, and lookup joins come
// exclusively from the catalog (Prisma.raw); everything user-supplied — filter
// values, date bounds, scope ids — binds as query parameters. Measure and
// dimension KEYS from the client are only ever used to index into the
// catalog, never interpolated.

type ServiceError = { error: string; code: string };

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

const clampLimit = (limit: number | undefined) => Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

function measureSelect(fact: FactDef, key: string): string | ServiceError {
  const measure = fact.measures[key];
  if (!measure) return { error: `Unknown measure: ${key}`, code: "UNKNOWN_MEASURE" };
  if (measure.kind !== "ratio") return `(${aggSql(measure)})::float8 AS "${key}"`;
  const num = ratioSide(fact, measure.numerator);
  if (typeof num !== "string") return num;
  const den = ratioSide(fact, measure.denominator);
  if (typeof den !== "string") return den;
  return `${num} / NULLIF(${den}, 0) AS "${key}"`;
}

/** Equality/membership predicate for one filter, with parameterized values. */
function filterSql(dim: DimensionDef, op: "eq" | "neq" | "in", value: string | string[]): Prisma.Sql | ServiceError {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return { error: "Filter has no values", code: "INVALID_FILTER" };
  const col = Prisma.raw(`f."${dim.column}"`);
  if (dim.type === "date") {
    if (op === "in") return { error: "Date filters support eq/neq only", code: "INVALID_FILTER" };
    if (!isValidDate(values[0])) return { error: `Invalid date filter value: ${values[0]}`, code: "INVALID_FILTER" };
    return op === "eq" ? Prisma.sql`${col} = ${values[0]}::date` : Prisma.sql`${col} <> ${values[0]}::date`;
  }
  if (dim.type === "id") {
    // Validate here (not just zod) so Postgres cast errors can't surface as 500s.
    const bad = values.find((v) => !UUID_RE.test(v));
    if (bad !== undefined) return { error: `Invalid id filter value: ${bad}`, code: "INVALID_FILTER" };
    if (op === "eq") return Prisma.sql`${col} = ${values[0]}::uuid`;
    if (op === "neq") return Prisma.sql`${col} IS DISTINCT FROM ${values[0]}::uuid`;
    return Prisma.sql`${col} = ANY(${values}::uuid[])`;
  }
  // enum/string columns compare as text so parameter types never fight the enum.
  const text = Prisma.raw(`f."${dim.column}"::text`);
  if (op === "eq") return Prisma.sql`${text} = ${values[0]}`;
  if (op === "neq") return Prisma.sql`${text} IS DISTINCT FROM ${values[0]}`;
  return Prisma.sql`${text} = ANY(${values})`;
}

export function compileReportQuery(query: ReportQuery, scope: ReportScope): Prisma.Sql | ServiceError {
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

  for (const [i, key] of query.dimensions.entries()) {
    const dim = fact.dimensions[key];
    if (!dim) return { error: `Unknown dimension: ${key}`, code: "UNKNOWN_DIMENSION" };
    const col = `f."${dim.column}"`;
    if (dim.type === "date") {
      // Date bucketing: day/week/month/year truncate businessDate — a plain
      // DATE already derived from the shift schedule at write time, so this is
      // pure calendar math with no timezone anywhere. Buckets come back as
      // 'YYYY-MM-DD' strings; clients must render them verbatim, never parse
      // them as instants (new Date("YYYY-MM-DD") is UTC midnight and shifts a
      // day in negative-offset zones).
      //
      // Hour truncates the event timestamp, pinned to UTC so bucket boundaries
      // don't depend on the session TimeZone (half-hour-offset zones would
      // otherwise shift them). Rendered as a UTC ISO string so every date
      // bucket — like every other ReportRow value — crosses the wire as
      // string|number|null; clients convert to the site zone for display.
      const expr =
        granularity === "hour"
          ? `to_char(date_trunc('hour', f."${fact.timeColumn}" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`
          : granularity === "day"
            ? `to_char(${col}, 'YYYY-MM-DD')`
            : `to_char(date_trunc('${granularity}', ${col}), 'YYYY-MM-DD')`;
      selects.push(`${expr} AS "${key}"`);
      groupBys.push(expr);
    } else {
      selects.push(`${col} AS "${key}"`);
      groupBys.push(col);
    }
    outputKeys.add(key);
    dimOrderExprs.set(
      key,
      dim.sortExpr ? `MIN(${dim.sortExpr.replaceAll("{a}", `d${i}`).replaceAll("{b}", `d${i}b`)})` : `"${key}"`,
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

  // ── WHERE: authz scope first, then catalog base filter, then user filters ──
  const where: Prisma.Sql[] = [Prisma.sql`${Prisma.raw('f."siteId"')} = ${scope.siteId}::uuid`];
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
  const dateCol = Prisma.raw(`f."${fact.dateColumn}"`);
  for (const bound of [query.dateFrom, query.dateTo]) {
    if (bound !== undefined && !isValidDate(bound)) {
      return { error: `Invalid date bound: ${bound}`, code: "INVALID_QUERY" };
    }
  }
  if (query.dateFrom) where.push(Prisma.sql`${dateCol} >= ${query.dateFrom}::date`);
  if (query.dateTo) where.push(Prisma.sql`${dateCol} <= ${query.dateTo}::date`);
  for (const filter of query.filters ?? []) {
    const dim = fact.dimensions[filter.dimension];
    if (!dim) return { error: `Unknown filter dimension: ${filter.dimension}`, code: "UNKNOWN_DIMENSION" };
    const predicate = filterSql(dim, filter.op, filter.value);
    if ("error" in predicate) return predicate;
    where.push(predicate);
  }

  // Fact defaults (e.g. granularity = SHIFT) apply unless the query PINS that
  // dimension itself — by grouping on it (separate rows per value can't
  // double-count) or filtering it to exactly one value. neq/multi-value
  // filters don't pin a grain, so the default stays and simply intersects.
  const addressed = new Set([
    ...query.dimensions,
    ...(query.filters ?? [])
      .filter((f) => f.op === "eq" || (f.op === "in" && Array.isArray(f.value) && f.value.length === 1))
      .map((f) => f.dimension),
  ]);
  for (const filter of fact.defaultFilters ?? []) {
    if (addressed.has(filter.dimension)) continue;
    const dim = fact.dimensions[filter.dimension];
    if (!dim) continue;
    const predicate = filterSql(dim, filter.op, filter.value);
    if ("error" in predicate) return predicate;
    where.push(predicate);
  }

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

  const from = fact.source ? `(${fact.source})` : fact.table ? `"${fact.table}"` : null;
  if (!from) return { error: `Fact ${query.fact} has neither table nor source`, code: "INVALID_FACT" };

  return Prisma.sql`
    SELECT ${Prisma.raw(selects.join(", "))}
    FROM ${Prisma.raw(from)} f
    ${Prisma.raw(joins.join(" "))}
    WHERE ${Prisma.join(where, " AND ")}
    ${Prisma.raw(groupBys.length > 0 ? `GROUP BY ${groupBys.join(", ")}` : "")}
    ORDER BY ${Prisma.raw(orderParts.join(", "))}
    LIMIT ${limit + 1} OFFSET ${offset}
  `;
}

export async function runReportQuery(query: ReportQuery, scope: ReportScope): Promise<ReportResult | ServiceError> {
  const sql = compileReportQuery(query, scope);
  if ("error" in sql) return sql;
  const limit = clampLimit(query.limit);
  const rows = await prisma.$queryRaw<ReportRow[]>(sql);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}
