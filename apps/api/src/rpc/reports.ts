/**
 * Dimensional report queries — the semantic layer's query surface.
 *
 * A report request names a fact, measures, and dimensions from the
 * @rockwarehq/metrics catalog; the compiler turns it into ONE SQL statement:
 * an inner scan of the fact table (raw columns only — no join ambiguity)
 * wrapped by an outer GROUP BY with label joins. Clients never send SQL, and
 * every key is validated against the catalog before compilation, so the
 * schema is not a public API.
 *
 * Ratio measures compile to ratio-of-SUMs with their catalog guards
 * (null = no production window, 0 = window but nothing happened) — never
 * an average of per-row ratios.
 */

import {
  type FactDefinition,
  type FactKey,
  FACTS,
  type FormulaNode,
  getDimension,
  getMeasure,
  type MeasureDefinition,
} from "@rockwarehq/metrics";
import { ORPCError } from "@orpc/server";
import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { getShiftForEntity } from "@rw/services/metrics/shift";
import { openHourOverlaySql, OVERLAY_COLS } from "@rw/services/metrics/read";
import { z } from "zod";
import { authRequired } from "./middleware.js";

// ============================================================================
// Input Schemas
// ============================================================================

const factSchema = z.enum(["cycle", "downtime", "scrap", "items", "materialUsage", "bucket"]);
const grainSchema = z.enum(["total", "hour", "shift", "day"]);

const timeRangeSchema = z.union([
  z.object({ from: z.coerce.date(), to: z.coerce.date() }),
  z.object({ businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD") }),
  z.object({ shift: z.literal("current") }),
]);

const filterSchema = z.object({
  dimension: z.string(),
  in: z.array(z.string()).min(1).max(200),
});

const orderSchema = z.object({
  by: z.string(),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

const queryCoreSchema = z.object({
  fact: factSchema,
  measures: z.array(z.string()).min(1).max(10),
  dimensions: z.array(z.string()).max(4).default([]),
  grain: grainSchema.default("total"),
  filters: z.array(filterSchema).max(10).default([]),
  order: orderSchema.optional(),
  limit: z.number().min(1).max(5000).default(1000),
});

const querySchema = queryCoreSchema.extend({
  siteId: z.uuid(),
  timeRange: timeRangeSchema,
});

const queryBatchSchema = z.object({
  siteId: z.uuid(),
  shared: z.object({
    timeRange: timeRangeSchema,
    filters: z.array(filterSchema).max(10).default([]),
  }),
  widgets: z
    .array(queryCoreSchema.extend({ id: z.string().min(1).max(64), timeRange: timeRangeSchema.optional() }))
    .min(1)
    .max(12),
});

type QueryInput = z.infer<typeof querySchema>;

// ============================================================================
// Compilation
// ============================================================================

interface ResolvedRange {
  from: Date;
  to: Date;
  /** Set when the range came from a businessDate — facts with a stamped
   *  businessDate column filter on it directly instead of the time column. */
  businessDate?: string;
}

async function resolveTimeRange(siteId: string, range: z.infer<typeof timeRangeSchema>): Promise<ResolvedRange> {
  if ("from" in range) {
    if (range.to <= range.from) throw new ORPCError("BAD_REQUEST", { message: "timeRange.to must be after from" });
    return { from: range.from, to: range.to };
  }
  if ("businessDate" in range) {
    const from = new Date(range.businessDate);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from, to, businessDate: range.businessDate };
  }
  const shift = await getShiftForEntity("SITE", siteId, siteId, new Date());
  if (!shift) throw new ORPCError("BAD_REQUEST", { message: "No current shift is scheduled for this site" });
  return { from: shift.startTime, to: new Date(shift.startTime.getTime() + shift.durationSeconds * 1000) };
}

/** Facts whose rows carry stamped businessDate / shiftInstanceId columns.
 *  Legacy rows carry NULLs until the backfill lands and group under a NULL
 *  bucket at shift/day grain. */
const STAMPED_FACTS: ReadonlySet<FactKey> = new Set(["cycle", "scrap", "downtime", "items", "materialUsage", "bucket"]);

// The bucket fact reads ONLY HOUR rows — the base grain. Shift/day grains
// are GROUP BYs over the stamped shiftInstanceId/businessDate columns
// (exact: hour rows are shift-aligned and never straddle a shift), and
// coarser sums over additive ingredients are always safe — ratios are
// computed once per output group, after summing.

function factColumn(fact: FactDefinition, dimKey: string): string {
  return fact.dimensionColumns?.[dimKey] ?? getDimension(dimKey).factColumn;
}

function validateQuery(q: QueryInput): { fact: FactDefinition; measures: MeasureDefinition[] } {
  const fact = FACTS[q.fact];
  const measures = q.measures.map((key) => {
    if (!fact.measures.includes(key)) {
      throw new ORPCError("BAD_REQUEST", { message: `Measure "${key}" is not available on fact "${q.fact}"` });
    }
    const measure = getMeasure(key);
    if (
      measure.requiresDimension &&
      !q.dimensions.includes(measure.requiresDimension) &&
      !q.filters.some((f) => f.dimension === measure.requiresDimension)
    ) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Measure "${key}" requires grouping or filtering by "${measure.requiresDimension}" — its sums are meaningless across it`,
      });
    }
    return measure;
  });
  for (const d of q.dimensions) {
    if (!fact.dimensions.includes(d)) {
      throw new ORPCError("BAD_REQUEST", { message: `Dimension "${d}" is not available on fact "${q.fact}"` });
    }
  }
  for (const f of q.filters) {
    if (!fact.dimensions.includes(f.dimension)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Filter dimension "${f.dimension}" is not available on "${q.fact}"`,
      });
    }
  }
  if ((q.grain === "shift" || q.grain === "day") && !STAMPED_FACTS.has(q.fact)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Grain "${q.grain}" requires stamped shift context, which fact "${q.fact}" does not carry yet`,
    });
  }
  if (q.order) {
    const orderable = new Set([...q.measures, ...q.dimensions, ...(q.grain !== "total" ? ["bucket"] : [])]);
    if (!orderable.has(q.order.by)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `order.by "${q.order.by}" is not a requested measure or dimension`,
      });
    }
  }
  return { fact, measures };
}

/** Render a formula AST to SQL over already-SUMmed dependency fragments. */
function formulaToSql(node: FormulaNode, dep: (key: string) => Prisma.Sql): Prisma.Sql {
  switch (node.kind) {
    case "field":
      return dep(node.key);
    case "const":
      return Prisma.raw(String(node.value));
    case "add":
      return Prisma.sql`(${formulaToSql(node.left, dep)} + ${formulaToSql(node.right, dep)})`;
    case "sub":
      return Prisma.sql`(${formulaToSql(node.left, dep)} - ${formulaToSql(node.right, dep)})`;
    case "mul":
      return Prisma.sql`(${formulaToSql(node.left, dep)} * ${formulaToSql(node.right, dep)})`;
    case "div":
      return Prisma.sql`(${formulaToSql(node.left, dep)} / NULLIF(${formulaToSql(node.right, dep)}, 0))`;
  }
}

/** SUM of an additive measure's inner projection, cast for float division. */
function sumOf(key: string): Prisma.Sql {
  return Prisma.sql`SUM(f.${Prisma.raw(`"m_${key}"`)})::float8`;
}

function measureSelect(m: MeasureDefinition): Prisma.Sql {
  if (m.kind === "additive") {
    return Prisma.sql`${sumOf(m.key)} AS ${Prisma.raw(`"${m.key}"`)}`;
  }
  if (!m.formula) throw new ORPCError("BAD_REQUEST", { message: `Ratio "${m.key}" has no formula` });
  const body = formulaToSql(m.formula, sumOf);
  const guards = m.guards ?? {};
  const clauses: Prisma.Sql[] = [];
  if (guards.nullWhenZero) clauses.push(Prisma.sql`WHEN COALESCE(${sumOf(guards.nullWhenZero)}, 0) <= 0 THEN NULL`);
  if (guards.zeroWhenZero) clauses.push(Prisma.sql`WHEN COALESCE(${sumOf(guards.zeroWhenZero)}, 0) <= 0 THEN 0`);
  const expr = clauses.length > 0 ? Prisma.sql`CASE ${Prisma.join(clauses, " ")} ELSE ${body} END` : body;
  return Prisma.sql`${expr} AS ${Prisma.raw(`"${m.key}"`)}`;
}

/** Label join + label expression for a dimension, given its bound column. */
function dimensionLabel(dimKey: string, boundColumn: string, alias: string): { join: Prisma.Sql; label: Prisma.Sql } {
  const idRef = Prisma.raw(`f."d_${dimKey}"`);
  const a = (s: string) => Prisma.raw(`${alias}.${s}`);
  switch (dimKey) {
    case "businessDate":
      return { join: Prisma.empty, label: Prisma.sql`to_char(${idRef}, 'YYYY-MM-DD')` };
    case "job":
      if (boundColumn === "jobVersionId") {
        return {
          join: Prisma.sql`LEFT JOIN "JobVersion" ${Prisma.raw(alias)} ON ${a("id")} = ${idRef}`,
          label: Prisma.sql`MAX(${a(`"name"`)})`,
        };
      }
      return {
        join: Prisma.sql`LEFT JOIN "Job" ${Prisma.raw(alias)} ON ${a("id")} = ${idRef}
          LEFT JOIN "JobVersion" ${Prisma.raw(`${alias}v`)} ON ${Prisma.raw(`${alias}v`)}.id = ${a(`"currentVersionId"`)}`,
        label: Prisma.sql`MAX(${Prisma.raw(`${alias}v."name"`)})`,
      };
    case "tool":
      if (boundColumn === "toolVersionId") {
        return {
          join: Prisma.sql`LEFT JOIN "ToolVersion" ${Prisma.raw(alias)} ON ${a("id")} = ${idRef}`,
          label: Prisma.sql`MAX(${a(`"name"`)})`,
        };
      }
      return {
        join: Prisma.sql`LEFT JOIN "Tool" ${Prisma.raw(alias)} ON ${a("id")} = ${idRef}
          LEFT JOIN "ToolVersion" ${Prisma.raw(`${alias}v`)} ON ${Prisma.raw(`${alias}v`)}.id = ${a(`"currentVersionId"`)}`,
        label: Prisma.sql`MAX(${Prisma.raw(`${alias}v."name"`)})`,
      };
    case "operator":
      return {
        join: Prisma.sql`LEFT JOIN "StationLogonSession" ${Prisma.raw(alias)} ON ${a("id")} = ${idRef}
          LEFT JOIN "EmployeeVersion" ${Prisma.raw(`${alias}v`)} ON ${Prisma.raw(`${alias}v`)}.id = ${a(`"versionId"`)}`,
        label: Prisma.sql`MAX(COALESCE(${a(`"genericName"`)}, ${Prisma.raw(`${alias}v."firstName"`)} || ' ' || ${Prisma.raw(`${alias}v."lastName"`)}))`,
      };
    case "product":
      if (boundColumn === "productVersionId") {
        return {
          join: Prisma.sql`LEFT JOIN "ProductVersion" ${Prisma.raw(alias)} ON ${a("id")} = ${idRef}`,
          label: Prisma.sql`MAX(${a(`"sku"`)})`,
        };
      }
      return {
        join: Prisma.sql`LEFT JOIN "Product" ${Prisma.raw(alias)} ON ${a("id")} = ${idRef}
          LEFT JOIN "ProductVersion" ${Prisma.raw(`${alias}v`)} ON ${Prisma.raw(`${alias}v`)}.id = ${a(`"currentVersionId"`)}`,
        label: Prisma.sql`MAX(${Prisma.raw(`${alias}v."sku"`)})`,
      };
    case "material":
      return {
        join: Prisma.sql`LEFT JOIN "Material" ${Prisma.raw(alias)} ON ${a("id")} = ${idRef}
          LEFT JOIN "MaterialVersion" ${Prisma.raw(`${alias}v`)} ON ${Prisma.raw(`${alias}v`)}.id = ${a(`"currentVersionId"`)}`,
        label: Prisma.sql`MAX(COALESCE(${Prisma.raw(`${alias}v."name"`)}, ${Prisma.raw(`${alias}v."materialNumber"`)}))`,
      };
    default: {
      const dim = getDimension(dimKey);
      if (!dim.dimTable || !dim.labelColumn) {
        return { join: Prisma.empty, label: Prisma.sql`NULL` };
      }
      return {
        join: Prisma.sql`LEFT JOIN ${Prisma.raw(`"${dim.dimTable}"`)} ${Prisma.raw(alias)} ON ${a("id")} = ${idRef}`,
        label: Prisma.sql`MAX(${a(`"${dim.labelColumn}"`)})`,
      };
    }
  }
}

async function runQuery(siteId: string, q: QueryInput, range: ResolvedRange): Promise<Record<string, unknown>[]> {
  const { fact, measures } = validateQuery(q);

  // grain=shift is the shift dimension with a time meaning — normalize.
  const dimensions = q.grain === "shift" && !q.dimensions.includes("shift") ? [...q.dimensions, "shift"] : q.dimensions;

  // ── Inner scan: raw fact columns only, no joins → no ambiguity ──
  const innerSelects: Prisma.Sql[] = [];
  for (const dimKey of dimensions) {
    innerSelects.push(Prisma.raw(`"${factColumn(fact, dimKey)}" AS "d_${dimKey}"`));
  }
  if (q.grain === "hour") {
    // Bucket rows ARE hour buckets (shift-anchored, variable-width — an
    // 11:45 shift yields 11:45–12:45 rows): group by the row's own
    // startTime, never date_trunc, which would mislabel anchored buckets.
    // Raw facts have no bucket identity and keep clock-hour truncation.
    innerSelects.push(
      q.fact === "bucket"
        ? Prisma.raw(`"startTime" AS "g_bucket"`)
        : Prisma.raw(`date_trunc('hour', ${fact.timeColumn}) AS "g_bucket"`),
    );
  } else if (q.grain === "day" && !dimensions.includes("businessDate")) {
    innerSelects.push(Prisma.raw(`"businessDate" AS "d_businessDate"`));
  }
  // Project each measure's per-row expression; ratio deps are additive
  // measures of the same fact family, projected alongside.
  const projected = new Set<string>();
  const projectMeasure = (m: MeasureDefinition) => {
    if (projected.has(m.key)) return;
    projected.add(m.key);
    if (m.kind === "additive") {
      innerSelects.push(Prisma.raw(`${m.agg === "count" ? "1" : `(${m.sql})`} AS "m_${m.key}"`));
    } else {
      for (const dep of m.deps ?? []) projectMeasure(getMeasure(dep));
    }
  };
  for (const m of measures) projectMeasure(m);

  const where: Prisma.Sql[] = [];
  // Site scope + soft delete. StationStateLog carries no siteId — scope
  // through an EXISTS on Station to keep the scan join-free.
  if (q.fact === "downtime") {
    where.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "Station" st WHERE st.id = "stationId" AND st."siteId" = ${siteId}::uuid)`,
    );
  } else {
    where.push(Prisma.sql`"siteId" = ${siteId}::uuid`);
  }
  if (q.fact === "bucket") {
    // STATION-family HOUR rows only — the base grain. Workcenter/site/job
    // slices and rollup tiers are derived re-sums of these; summing station
    // rows is always correct and never double counts (per-job rows plus the
    // no-job residual sum to the station total).
    where.push(Prisma.sql`"entityType" = 'STATION'`);
    where.push(Prisma.sql`"granularity" = 'HOUR'::"BucketGranularity"`);
  } else if (fact.softDelete !== false) {
    where.push(Prisma.sql`"deletedAt" IS NULL`);
  }
  // Time window: stamped businessDate wins when the range is a business day.
  if (range.businessDate && STAMPED_FACTS.has(q.fact)) {
    where.push(Prisma.sql`"businessDate" = ${range.businessDate}::date`);
  } else {
    const timeCol = Prisma.raw(fact.timeColumn);
    where.push(Prisma.sql`${timeCol} >= ${range.from} AND ${timeCol} < ${range.to}`);
  }
  for (const f of q.filters) {
    const col = Prisma.raw(`"${factColumn(fact, f.dimension)}"`);
    if (f.dimension === "businessDate") {
      where.push(Prisma.sql`${col} = ANY(${f.in}::date[])`);
    } else {
      where.push(Prisma.sql`${col} = ANY(${f.in}::uuid[])`);
    }
  }

  const projection = Prisma.join(innerSelects, ", ");
  const whereSql = Prisma.join(where, " AND ");

  // ── Open-hour overlay (bucket fact only) ──
  // Stage D: open STATION HOUR rows' duration/elapsed/expected columns
  // are stale in the DB between transitions — reads must compute them
  // live. Applied only when the query's range touches "now" (historical
  // ranges see only closed rows, so the join would be pure cost). The
  // measure SQL strings reference plain quoted columns, so the overlay is
  // spliced in by wrapping the live table in a subquery (aliased back to
  // "MetricBucket") that projects COALESCE(computed, stored) for the
  // overlay columns; counts always come from the stored row.
  const overlayNow = new Date();
  const useOverlay = q.fact === "bucket" && range.to.getTime() >= overlayNow.getTime() - 2 * 60 * 60 * 1000;
  const overlayWith = useOverlay
    ? Prisma.sql`WITH ${openHourOverlaySql(
        overlayNow,
        range.businessDate && STAMPED_FACTS.has(q.fact)
          ? Prisma.sql`AND mb."siteId" = ${siteId}::uuid AND mb."businessDate" = ${range.businessDate}::date`
          : Prisma.sql`AND mb."siteId" = ${siteId}::uuid AND mb."startTime" >= ${range.from} AND mb."startTime" < ${range.to}`,
      )}`
    : Prisma.empty;
  const liveBucketTable = useOverlay
    ? Prisma.sql`(
        SELECT mb.id, mb."siteId", mb."entityType", mb.granularity, mb."entityId", mb."jobId",
          mb."startTime", mb."durationSeconds", mb."shiftInstanceId", mb."businessDate",
          mb."totalCycles", mb."badCycles", mb."totalItems", mb."badItems",
          mb."idealCycleSeconds", mb."totalCycleSeconds",
          ${Prisma.raw(OVERLAY_COLS.map((c) => `COALESCE(o."${c}", mb."${c}") AS "${c}"`).join(", "))}
        FROM "MetricBucket" mb
        LEFT JOIN open_hour_overlay o
          ON mb."closedAt" IS NULL
          AND o."entityId" = mb."entityId"
          AND o."startTime" = mb."startTime"
          AND o."jobId" IS NOT DISTINCT FROM mb."jobId"
      ) "MetricBucket"`
    : Prisma.sql`"MetricBucket"`;

  // Bucket rows migrate live → archive at business-day rollover; read both,
  // archive winning id collisions (the historian's convention).
  const inner =
    q.fact === "bucket"
      ? Prisma.sql`
    SELECT ${projection} FROM "MetricBucketLog" WHERE ${whereSql}
    UNION ALL
    SELECT ${projection} FROM ${liveBucketTable} WHERE ${whereSql}
      AND NOT EXISTS (SELECT 1 FROM "MetricBucketLog" mbl WHERE mbl.id = "MetricBucket".id)
  `
      : Prisma.sql`
    SELECT ${projection}
    FROM ${Prisma.raw(`"${fact.table}"`)}
    WHERE ${whereSql}
  `;

  // ── Outer: labels + GROUP BY + aggregated measures ──
  const outerSelects: Prisma.Sql[] = [];
  const groupBy: Prisma.Sql[] = [];
  const labelJoins: Prisma.Sql[] = [];
  let aliasIdx = 0;
  for (const dimKey of dimensions) {
    const idRef = Prisma.raw(`f."d_${dimKey}"`);
    const { join, label } = dimensionLabel(dimKey, factColumn(fact, dimKey), `l${aliasIdx++}`);
    if (join !== Prisma.empty) labelJoins.push(join);
    outerSelects.push(Prisma.sql`${idRef} AS ${Prisma.raw(`"${dimKey}Id"`)}`);
    outerSelects.push(Prisma.sql`${label} AS ${Prisma.raw(`"${dimKey}Label"`)}`);
    groupBy.push(idRef);
  }
  if (q.grain === "hour") {
    outerSelects.push(Prisma.sql`f."g_bucket" AS "bucket"`);
    groupBy.push(Prisma.sql`f."g_bucket"`);
  } else if (q.grain === "day" && !dimensions.includes("businessDate")) {
    outerSelects.push(Prisma.sql`f."d_businessDate" AS "bucket"`);
    groupBy.push(Prisma.sql`f."d_businessDate"`);
  }
  for (const m of measures) outerSelects.push(measureSelect(m));

  const orderBy = q.order
    ? Prisma.sql`ORDER BY ${Prisma.raw(
        q.order.by === "bucket" || q.measures.includes(q.order.by) ? `"${q.order.by}"` : `"${q.order.by}Label"`,
      )} ${Prisma.raw(q.order.dir === "asc" ? "ASC" : "DESC")} NULLS LAST`
    : q.grain !== "total"
      ? Prisma.sql`ORDER BY "bucket" ASC`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    ${overlayWith}
    SELECT ${Prisma.join(outerSelects, ", ")}
    FROM (${inner}) f
    ${labelJoins.length > 0 ? Prisma.join(labelJoins, " ") : Prisma.empty}
    ${groupBy.length > 0 ? Prisma.sql`GROUP BY ${Prisma.join(groupBy, ", ")}` : Prisma.empty}
    ${orderBy}
    LIMIT ${q.limit}
  `;
  return rows;
}

// ============================================================================
// Handlers
// ============================================================================

export const query = authRequired.input(querySchema).handler(async ({ input }) => {
  const range = await resolveTimeRange(input.siteId, input.timeRange);
  const rows = await runQuery(input.siteId, input, range);
  return { data: rows, resolvedRange: { from: range.from, to: range.to } };
});

export const queryBatch = authRequired.input(queryBatchSchema).handler(async ({ input }) => {
  // Resolve the shared range ONCE so every widget sees the same window.
  const sharedRange = await resolveTimeRange(input.siteId, input.shared.timeRange);

  const results: Record<string, { data?: Record<string, unknown>[]; error?: string }> = {};
  // Bounded concurrency — pooled connections are precious on PlanetScale.
  const CONCURRENCY = 4;
  const widgets = [...input.widgets];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, widgets.length) }, async () => {
      for (;;) {
        const w = widgets.shift();
        if (!w) return;
        try {
          const range = w.timeRange ? await resolveTimeRange(input.siteId, w.timeRange) : sharedRange;
          const merged: QueryInput = {
            ...w,
            siteId: input.siteId,
            timeRange: w.timeRange ?? input.shared.timeRange,
            filters: [...input.shared.filters, ...w.filters],
          };
          results[w.id] = { data: await runQuery(input.siteId, merged, range) };
        } catch (err) {
          results[w.id] = { error: err instanceof ORPCError ? err.message : "Query failed" };
          if (!(err instanceof ORPCError)) {
            console.error(`[reports] widget "${w.id}" failed:`, err);
          }
        }
      }
    }),
  );

  return { widgets: results, resolvedRange: { from: sharedRange.from, to: sharedRange.to } };
});
