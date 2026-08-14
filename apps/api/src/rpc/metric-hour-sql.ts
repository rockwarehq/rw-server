/**
 * Shared raw-SQL building blocks for reading the STATION-family HOUR grain of
 * MetricBucket/MetricBucketLog (Stage B of the star-schema cutover).
 *
 * Regime-proof predicates: pre-cutover a station-hour is one whole-station row
 * (jobId NULL); post-cutover it is per-job rows plus a no-job residual that SUM
 * to the station total. Station-scope reads therefore filter only on
 * entityType/granularity (never jobId) and aggregate; job-scope reads accept
 * both the legacy JOB tier and the new per-job STATION rows, deduping per
 * (entityId, jobId, startTime) with the STATION row winning.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@rw/db";
import type { QueryFilter, QueryRule } from "@rw/services/lib/query-filter/types";

// ---------------------------------------------------------------------------
// Synthetic ids
// ---------------------------------------------------------------------------

/** Deterministic uuid-shaped id for aggregate rows that no longer map 1:1 to a persisted bucket. */
export function syntheticBucketId(
  entityType: string,
  entityId: string,
  jobId: string | null | undefined,
  granularity: string,
  startTime: Date,
): string {
  const hex = createHash("md5")
    .update(`${entityType}|${entityId}|${jobId ?? ""}|${granularity}|${startTime.toISOString()}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Union source: live MetricBucket ∪ archived MetricBucketLog (live wins id collisions)
// ---------------------------------------------------------------------------

const HOUR_SRC_COLS = Prisma.sql`
  mb."entityType", mb."entityId", mb."jobId", mb."entityName", mb."path",
  mb."granularityName", mb."startTime", mb."durationSeconds", mb."shiftInstanceId",
  mb."businessDate", mb."businessShift", mb."currentJobName", mb."currentStandardCycle",
  mb."totalCycles", mb."expectedCycles", mb."badCycles", mb."goodCycles",
  mb."totalItems", mb."badItems", mb."goodItems", mb."expectedItems", mb."elapsedExpectedItems",
  mb."runSeconds", mb."downSeconds", mb."plannedDownSeconds", mb."unplannedDownSeconds",
  mb."idealCycleSeconds", mb."totalCycleSeconds", mb."elapsedPlannedProductionSeconds",
  mb."updatedAt"`;

/**
 * Rows matching `predicate` from the live table plus archived rows whose id is
 * not present live (a bucket may exist in both around archival; live wins).
 */
export function hourUnionSourceSql(predicate: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT ${HOUR_SRC_COLS} FROM "MetricBucket" mb WHERE ${predicate}
    UNION ALL
    SELECT ${HOUR_SRC_COLS} FROM "MetricBucketLog" mb
    WHERE ${predicate}
      AND NOT EXISTS (SELECT 1 FROM "MetricBucket" b WHERE b.id = mb.id)`;
}

/** Station scope: whole-station totals. Deliberately no jobId predicate — see module doc. */
export const STATION_HOUR_PREDICATE = Prisma.sql`mb."entityType" = 'STATION' AND mb."granularity" = 'HOUR'`;

/** Job scope: legacy JOB-tier rows and new per-job STATION rows (entityId = station id in both). */
export const JOB_HOUR_PREDICATE = Prisma.sql`(mb."entityType" = 'JOB' OR (mb."entityType" = 'STATION' AND mb."jobId" IS NOT NULL))
  AND mb."granularity" = 'HOUR' AND mb."jobId" IS NOT NULL`;

/** Dedup a job-scope source per (entityId, jobId, startTime), STATION row preferred. */
export function jobDedupSql(src: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT ON ("entityId", "jobId", "startTime") *
    FROM (${src}) jsrc
    ORDER BY "entityId", "jobId", "startTime", ("entityType" = 'STATION') DESC`;
}

// ---------------------------------------------------------------------------
// Aggregate select fragments
// ---------------------------------------------------------------------------

function a(alias: string): Prisma.Sql {
  return Prisma.raw(`"${alias}"`);
}

/** SUM(...) of every additive KPI column, aliased with the source column names. */
export function kpiSumsSql(alias: string): Prisma.Sql {
  const t = a(alias);
  return Prisma.sql`
    SUM(${t}."totalCycles")::int AS "totalCycles",
    SUM(${t}."expectedCycles")::int AS "expectedCycles",
    SUM(${t}."badCycles")::int AS "badCycles",
    SUM(${t}."goodCycles")::int AS "goodCycles",
    SUM(${t}."totalItems")::int AS "totalItems",
    SUM(${t}."badItems")::int AS "badItems",
    SUM(${t}."goodItems")::int AS "goodItems",
    SUM(${t}."expectedItems")::int AS "expectedItems",
    SUM(${t}."elapsedExpectedItems")::int AS "elapsedExpectedItems",
    SUM(${t}."runSeconds")::int AS "runSeconds",
    SUM(${t}."downSeconds")::int AS "downSeconds",
    SUM(${t}."plannedDownSeconds")::int AS "plannedDownSeconds",
    SUM(${t}."unplannedDownSeconds")::int AS "unplannedDownSeconds",
    SUM(${t}."idealCycleSeconds")::int AS "idealCycleSeconds",
    SUM(${t}."totalCycleSeconds")::int AS "totalCycleSeconds",
    SUM(${t}."elapsedPlannedProductionSeconds")::int AS "elapsedPlannedProductionSeconds"`;
}

/**
 * Ratio-of-sums with the same guard semantics as the DB generated columns
 * (ratios are never summed): NULL when there is no production window,
 * performance/quality/oee 0 when the respective denominator is 0.
 */
export function ratioSumsSql(alias: string): Prisma.Sql {
  const t = a(alias);
  return Prisma.sql`
    CASE WHEN SUM(${t}."elapsedPlannedProductionSeconds") <= 0 THEN NULL
         ELSE (SUM(${t}."runSeconds")::numeric / SUM(${t}."elapsedPlannedProductionSeconds")::numeric)::numeric(10,6)
    END AS "availability",
    CASE WHEN SUM(${t}."elapsedPlannedProductionSeconds") <= 0 THEN NULL
         WHEN SUM(${t}."runSeconds") <= 0 THEN 0
         ELSE (SUM(${t}."idealCycleSeconds")::numeric / SUM(${t}."runSeconds")::numeric)::numeric(10,6)
    END AS "performance",
    CASE WHEN SUM(${t}."elapsedPlannedProductionSeconds") <= 0 THEN NULL
         WHEN SUM(${t}."totalItems") <= 0 THEN 0
         ELSE ((SUM(${t}."totalItems") - SUM(${t}."badItems"))::numeric / SUM(${t}."totalItems")::numeric)::numeric(10,6)
    END AS "quality",
    CASE WHEN SUM(${t}."elapsedPlannedProductionSeconds") <= 0 THEN NULL
         WHEN SUM(${t}."totalItems") <= 0 THEN 0
         ELSE ((SUM(${t}."idealCycleSeconds")::numeric * (SUM(${t}."totalItems") - SUM(${t}."badItems"))::numeric)
               / (SUM(${t}."elapsedPlannedProductionSeconds")::numeric * SUM(${t}."totalItems")::numeric))::numeric(10,6)
    END AS "oee"`;
}

/**
 * Value of `col` on the latest contributing row that has one (NULL when none
 * do). `orderBy` must be a full ORDER BY body, e.g. `s."startTime" DESC`.
 */
export function latestNonNullSql(col: Prisma.Sql, orderBy: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(ARRAY_AGG(${col} ORDER BY ${orderBy}) FILTER (WHERE ${col} IS NOT NULL))[1]`;
}

// ---------------------------------------------------------------------------
// Dynamic query-filter → SQL (parity with query-filter/toPrismaWhere semantics)
// ---------------------------------------------------------------------------

export interface SqlFilterField {
  sql: Prisma.Sql;
  type: "string" | "number";
}

class BadRequestError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/**
 * Render a validated QueryFilter tree as a SQL boolean expression over the
 * given field map. Returns `AND (...)` for appending to a `WHERE TRUE`, or
 * empty when the filter produces no conditions. Unknown fields throw 400
 * (same as toPrismaWhere); rules with empty values are skipped.
 */
export function queryFilterToSql(query: QueryFilter | undefined, fields: Record<string, SqlFilterField>): Prisma.Sql {
  if (!query) return Prisma.empty;
  const expr = groupToSql(query, fields);
  if (expr === null) return Prisma.empty;
  return Prisma.sql`AND (${expr})`;
}

function groupToSql(group: QueryFilter, fields: Record<string, SqlFilterField>): Prisma.Sql | null {
  const parts = group.rules
    .map((rule) =>
      "combinator" in rule ? groupToSql(rule as QueryFilter, fields) : ruleToSql(rule as QueryRule, fields),
    )
    .filter((p): p is Prisma.Sql => p !== null);
  if (parts.length === 0) return null;
  const sep = group.combinator === "and" ? " AND " : " OR ";
  return Prisma.sql`(${Prisma.join(parts, sep)})`;
}

function ruleToSql(rule: QueryRule, fields: Record<string, SqlFilterField>): Prisma.Sql | null {
  const field = fields[rule.field];
  if (!field) {
    throw new BadRequestError(`Field "${rule.field}" is not queryable`);
  }
  const col = field.sql;

  if (rule.operator === "null") return Prisma.sql`${col} IS NULL`;
  if (rule.operator === "notNull") return Prisma.sql`${col} IS NOT NULL`;

  // Skip incomplete rules (empty value) — parity with toPrismaWhere
  if (rule.value === null || rule.value === undefined || rule.value === "") return null;

  const coerce = (v: unknown): string | number =>
    field.type === "number" ? (typeof v === "number" ? v : Number(v)) : String(v);

  const toArray = (v: unknown): Array<string | number> => {
    if (Array.isArray(v)) return v.map(coerce);
    if (typeof v === "string")
      return v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(coerce);
    return [coerce(v)];
  };

  switch (rule.operator) {
    case "=":
      return Prisma.sql`${col} = ${coerce(rule.value)}`;
    case "!=":
      return Prisma.sql`${col} <> ${coerce(rule.value)}`;
    case ">":
      return Prisma.sql`${col} > ${coerce(rule.value)}`;
    case "<":
      return Prisma.sql`${col} < ${coerce(rule.value)}`;
    case ">=":
      return Prisma.sql`${col} >= ${coerce(rule.value)}`;
    case "<=":
      return Prisma.sql`${col} <= ${coerce(rule.value)}`;
    case "contains":
      return Prisma.sql`${col}::text ILIKE ${`%${String(rule.value)}%`}`;
    case "beginsWith":
      return Prisma.sql`${col}::text ILIKE ${`${String(rule.value)}%`}`;
    case "in": {
      const arr = toArray(rule.value);
      if (arr.length === 0) return null;
      return Prisma.sql`${col} IN (${Prisma.join(arr)})`;
    }
    case "notIn": {
      const arr = toArray(rule.value);
      if (arr.length === 0) return null;
      return Prisma.sql`${col} NOT IN (${Prisma.join(arr)})`;
    }
    case "between": {
      const pair = toBetweenPair(rule.value, coerce);
      return Prisma.sql`(${col} >= ${pair[0]} AND ${col} <= ${pair[1]})`;
    }
    case "notBetween": {
      const pair = toBetweenPair(rule.value, coerce);
      return Prisma.sql`(${col} < ${pair[0]} OR ${col} > ${pair[1]})`;
    }
    default:
      return null;
  }
}

function toBetweenPair(value: unknown, coerce: (v: unknown) => string | number): [string | number, string | number] {
  let arr: unknown[];
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === "string") {
    arr = value.split(",").map((s) => s.trim());
  } else {
    throw new BadRequestError("between/notBetween requires two values");
  }
  if (arr.length !== 2) {
    throw new BadRequestError("between/notBetween requires exactly two values");
  }
  return [coerce(arr[0]), coerce(arr[1])];
}
