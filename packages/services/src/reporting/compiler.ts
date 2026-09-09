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

/** COUNT(*)/SUM(expr) for an additive measure (ratio handled by the caller). */
function aggSql(measure: Exclude<MeasureDef, { kind: "ratio" }>): string {
  if (measure.kind === "count") return "COUNT(*)";
  return `${measure.kind.toUpperCase()}(${measure.expr})`;
}

function measureSelect(fact: FactDef, key: string): string | ServiceError {
  const measure = fact.measures[key];
  if (!measure) return { error: `Unknown measure: ${key}`, code: "UNKNOWN_MEASURE" };
  if (measure.kind !== "ratio") return `(${aggSql(measure)})::float8 AS "${key}"`;
  const num = fact.measures[measure.numerator];
  const den = fact.measures[measure.denominator];
  if (!num || num.kind === "ratio" || !den || den.kind === "ratio") {
    return { error: `Ratio measure ${key} has invalid components`, code: "INVALID_MEASURE" };
  }
  return `(${aggSql(num)})::float8 / NULLIF((${aggSql(den)})::float8, 0) AS "${key}"`;
}

/** Equality/membership predicate for one filter, with parameterized values. */
function filterSql(dim: DimensionDef, op: "eq" | "neq" | "in", value: string | string[]): Prisma.Sql | ServiceError {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return { error: "Filter has no values", code: "INVALID_FILTER" };
  const col = Prisma.raw(`f."${dim.column}"`);
  if (dim.type === "date") {
    if (op === "in") return { error: "Date filters support eq/neq only", code: "INVALID_FILTER" };
    return op === "eq" ? Prisma.sql`${col} = ${values[0]}::date` : Prisma.sql`${col} <> ${values[0]}::date`;
  }
  if (dim.type === "id") {
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

  query.dimensions.forEach((key, i) => {
    const dim = fact.dimensions[key];
    if (!dim) return; // validated below
    const col = `f."${dim.column}"`;
    if (dim.type === "date") {
      selects.push(`to_char(${col}, 'YYYY-MM-DD') AS "${key}"`);
    } else {
      selects.push(`${col} AS "${key}"`);
    }
    groupBys.push(col);
    outputKeys.add(key);
    if (dim.lookup) {
      const name = dim.lookup.name.replaceAll("{a}", `d${i}`).replaceAll("{b}", `d${i}b`);
      joins.push(dim.lookup.join.replaceAll("{a}", `d${i}`).replaceAll("{b}", `d${i}b`));
      selects.push(`${name} AS "${key}Name"`);
      groupBys.push(name);
      outputKeys.add(`${key}Name`);
    }
  });
  const badDim = query.dimensions.find((key) => !fact.dimensions[key]);
  if (badDim) return { error: `Unknown dimension: ${badDim}`, code: "UNKNOWN_DIMENSION" };

  for (const key of query.measures) {
    const select = measureSelect(fact, key);
    if (typeof select !== "string") return select;
    selects.push(select);
    outputKeys.add(key);
  }

  // ── WHERE: authz scope first, then catalog base filter, then user filters ──
  const where: Prisma.Sql[] = [Prisma.sql`${Prisma.raw('f."siteId"')} = ${scope.siteId}::uuid`];
  if (fact.workcenterColumn && scope.workcenterIds) {
    const wc = Prisma.raw(`f."${fact.workcenterColumn}"`);
    where.push(Prisma.sql`(${wc} = ANY(${scope.workcenterIds}::uuid[]) OR ${wc} IS NULL)`);
  }
  if (fact.baseFilter) where.push(Prisma.sql`${Prisma.raw(fact.baseFilter)}`);
  const dateCol = Prisma.raw(`f."${fact.dateColumn}"`);
  if (query.dateFrom) where.push(Prisma.sql`${dateCol} >= ${query.dateFrom}::date`);
  if (query.dateTo) where.push(Prisma.sql`${dateCol} <= ${query.dateTo}::date`);
  for (const filter of query.filters ?? []) {
    const dim = fact.dimensions[filter.dimension];
    if (!dim) return { error: `Unknown filter dimension: ${filter.dimension}`, code: "UNKNOWN_DIMENSION" };
    const predicate = filterSql(dim, filter.op, filter.value);
    if ("error" in predicate) return predicate;
    where.push(predicate);
  }

  // ── ORDER BY a selected output key; default: first dimension, else first measure ──
  const orderKey = query.orderBy?.field ?? query.dimensions[0] ?? query.measures[0];
  if (!outputKeys.has(orderKey)) {
    return { error: `orderBy field must be a selected dimension or measure: ${orderKey}`, code: "INVALID_QUERY" };
  }
  const orderDir = query.orderBy?.dir === "desc" ? "DESC" : "ASC";

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);

  return Prisma.sql`
    SELECT ${Prisma.raw(selects.join(", "))}
    FROM ${Prisma.raw(`"${fact.table}"`)} f
    ${Prisma.raw(joins.join(" "))}
    WHERE ${Prisma.join(where, " AND ")}
    ${Prisma.raw(groupBys.length > 0 ? `GROUP BY ${groupBys.join(", ")}` : "")}
    ORDER BY ${Prisma.raw(`"${orderKey}" ${orderDir} NULLS LAST`)}
    LIMIT ${limit + 1} OFFSET ${offset}
  `;
}

export async function runReportQuery(query: ReportQuery, scope: ReportScope): Promise<ReportResult | ServiceError> {
  const sql = compileReportQuery(query, scope);
  if ("error" in sql) return sql;
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = await prisma.$queryRaw<ReportRow[]>(sql);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}
