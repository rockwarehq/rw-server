/**
 * Log search endpoints — paginated, filterable queries for historical log viewers.
 */

import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import {
  queryFilterSchema,
  toPrismaWhere,
  toRowFilter,
  type FieldAllowlist,
} from "@rw/services/lib/query-filter/index";
import type { QueryFilter, QueryRule } from "@rw/services/lib/query-filter/types";
import {
  hourUnionSourceSql,
  jobDedupSql,
  kpiSumsSql,
  latestNonNullSql,
  queryFilterToSql,
  ratioSumsSql,
  syntheticBucketId,
  JOB_HOUR_PREDICATE,
  STATION_HOUR_PREDICATE,
  type SqlFilterField,
} from "./metric-hour-sql.js";

// ---------------------------------------------------------------------------
// Field allowlists — only these fields can be queried dynamically.
// ---------------------------------------------------------------------------

/**
 * metricBucketLogSearch computes its rows in SQL, so the allowlist maps each
 * queryable field to the aggregate output column it filters on.
 */
const METRIC_BUCKET_QUERYABLE_FIELDS: Record<string, SqlFilterField> = {
  entityName: { sql: Prisma.sql`g."entityName"`, type: "string" },
  entityType: { sql: Prisma.sql`g."entityType"`, type: "string" },
  businessShift: { sql: Prisma.sql`g."businessShift"`, type: "string" },
  currentJobName: { sql: Prisma.sql`g."currentJobName"`, type: "string" },
  totalCycles: { sql: Prisma.sql`g."totalCycles"`, type: "number" },
  goodCycles: { sql: Prisma.sql`g."goodCycles"`, type: "number" },
  badCycles: { sql: Prisma.sql`g."badCycles"`, type: "number" },
  totalItems: { sql: Prisma.sql`g."totalItems"`, type: "number" },
  goodItems: { sql: Prisma.sql`g."goodItems"`, type: "number" },
  badItems: { sql: Prisma.sql`g."badItems"`, type: "number" },
  runSeconds: { sql: Prisma.sql`g."runSeconds"`, type: "number" },
  downSeconds: { sql: Prisma.sql`g."downSeconds"`, type: "number" },
  availability: { sql: Prisma.sql`g."availability"`, type: "number" },
  performance: { sql: Prisma.sql`g."performance"`, type: "number" },
  quality: { sql: Prisma.sql`g."quality"`, type: "number" },
  oee: { sql: Prisma.sql`g."oee"`, type: "number" },
};

const DISPOSITION_LOG_QUERYABLE_FIELDS: FieldAllowlist = {
  stationId: { column: "stationId", type: "uuid" },
  stationName: { column: "station.name", type: "string" },
  quantity: { column: "quantity", type: "number" },
  dispositionName: { column: "itemDisposition.name", type: "string" },
  reasonName: { column: "dispositionReason.name", type: "string" },
  productName: { column: "productVersion.name", type: "string" },
  productSku: { column: "productVersion.sku", type: "string" },
  toolName: { column: "toolVersion.name", type: "string" },
  cavityName: { column: "toolCavityVersion.name", type: "string" },
  shiftName: { column: "shiftInstance.shiftName", type: "string" },
};

const LOGON_LOG_QUERYABLE_FIELDS: FieldAllowlist = {
  stationId: { column: "stationId", type: "uuid" },
  stationName: { column: "station.name", type: "string" },
  displayName: { column: "display.name", type: "string" },
  employeeNumber: { column: "employee.employeeNumber", type: "string" },
  logonMethod: { column: "logonMethod", type: "string" },
  shiftName: { column: "shiftInstance.shiftName", type: "string" },
};

/** Downtime rows are computed in JS (shift-clamped), so we filter in-memory. */
const DOWNTIME_QUERYABLE_FIELDS: FieldAllowlist = {
  stationId: { column: "stationId", type: "uuid" },
  stationName: { column: "stationName", type: "string" },
  shiftName: { column: "shiftName", type: "string" },
  durationSeconds: { column: "durationSeconds", type: "number" },
  statusReasonId: { column: "statusReasonId", type: "uuid" },
  statusReasonName: { column: "statusReasonName", type: "string" },
  isPlannedDown: { column: "isPlannedDown", type: "boolean" },
  categoryName: { column: "categoryName", type: "string" },
  startTime: { column: "startTime", type: "datetime" },
  endTime: { column: "endTime", type: "datetime" },
  jobName: { column: "jobName", type: "string" },
};

// ============================================================================
// Metric Bucket Log search
// ============================================================================

const metricBucketLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  entityType: z.enum(["STATION", "WORKCENTER", "JOB"]).optional(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  shiftInstanceId: z.uuid().optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

/** Aggregate columns every entity-scope subquery of metricBucketLogSearch produces. */
type MetricSearchRow = {
  entityType: "STATION" | "WORKCENTER" | "JOB";
  entityId: string;
  jobId: string | null;
  entityName: string | null;
  path: string | null;
  granularityName: string | null;
  startTime: Date;
  durationSeconds: number | null;
  shiftInstanceId: string;
  businessDate: Date | null;
  businessShift: string | null;
  currentJobName: string | null;
  totalCycles: number;
  expectedCycles: number;
  badCycles: number;
  goodCycles: number;
  totalItems: number;
  badItems: number;
  goodItems: number;
  expectedItems: number;
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  availability: Prisma.Decimal | null;
  performance: Prisma.Decimal | null;
  quality: Prisma.Decimal | null;
  oee: Prisma.Decimal | null;
  totalCount: number;
};

const METRIC_SEARCH_SORTABLE: Record<string, Prisma.Sql> = {
  entityName: Prisma.sql`g."entityName"`,
  startTime: Prisma.sql`g."startTime"`,
  businessDate: Prisma.sql`g."businessDate"`,
  businessShift: Prisma.sql`g."businessShift"`,
  currentJobName: Prisma.sql`g."currentJobName"`,
  durationSeconds: Prisma.sql`g."durationSeconds"`,
  totalCycles: Prisma.sql`g."totalCycles"`,
  goodCycles: Prisma.sql`g."goodCycles"`,
  badCycles: Prisma.sql`g."badCycles"`,
  expectedCycles: Prisma.sql`g."expectedCycles"`,
  totalItems: Prisma.sql`g."totalItems"`,
  goodItems: Prisma.sql`g."goodItems"`,
  badItems: Prisma.sql`g."badItems"`,
  expectedItems: Prisma.sql`g."expectedItems"`,
  runSeconds: Prisma.sql`g."runSeconds"`,
  downSeconds: Prisma.sql`g."downSeconds"`,
  plannedDownSeconds: Prisma.sql`g."plannedDownSeconds"`,
  unplannedDownSeconds: Prisma.sql`g."unplannedDownSeconds"`,
  availability: Prisma.sql`g."availability"`,
  performance: Prisma.sql`g."performance"`,
  quality: Prisma.sql`g."quality"`,
  oee: Prisma.sql`g."oee"`,
};

export const metricBucketLogSearch = userOrDisplayRequired
  .input(metricBucketLogSearchInputSchema)
  .handler(async ({ input }) => {
    // Stage B: per-shift rows are aggregated on the fly from STATION-family
    // HOUR buckets — one output row per entity × shift instance. Reads
    // live ∪ archived (the old code read MetricBucketLog only, so shifts of
    // the current business day were invisible; the union is strictly more
    // complete).

    // ── Entity scoping ──
    type ScopeKind = "STATION" | "WORKCENTER" | "JOB";
    const scopes: Array<{ kind: ScopeKind; stationIds?: string[]; workCenterId?: string }> = [];

    if (input.stationId) {
      if (input.entityType === "JOB") {
        scopes.push({ kind: "JOB", stationIds: [input.stationId] });
      } else {
        scopes.push({ kind: "STATION", stationIds: [input.stationId] });
      }
    } else if (input.workCenterId) {
      const stations = await prisma.station.findMany({
        where: { siteId: input.siteId, workcenterId: input.workCenterId },
        select: { id: true },
      });
      const stationIds = stations.map((s) => s.id);
      if (input.entityType === "STATION") {
        scopes.push({ kind: "STATION", stationIds });
      } else if (input.entityType === "JOB") {
        scopes.push({ kind: "JOB", stationIds });
      } else if (input.entityType === "WORKCENTER") {
        scopes.push({ kind: "WORKCENTER", stationIds, workCenterId: input.workCenterId });
      } else {
        scopes.push({ kind: "WORKCENTER", stationIds, workCenterId: input.workCenterId });
        scopes.push({ kind: "STATION", stationIds });
      }
    } else if (input.entityType) {
      scopes.push({ kind: input.entityType });
    } else {
      // No entityType: station + workcenter families. (The old SHIFT-tier
      // table also contained SITE and JOB rows in this case; those are
      // intentionally dropped — the log viewer always scopes by type.)
      scopes.push({ kind: "STATION" });
      scopes.push({ kind: "WORKCENTER" });
    }

    const active = scopes.filter((s) => s.stationIds === undefined || s.stationIds.length > 0);
    if (active.length === 0) return { data: [], total: 0 };

    // ── Source predicates (evaluated against alias `mb` in the union) ──
    const baseParts: Prisma.Sql[] = [
      Prisma.sql`mb."siteId" = ${input.siteId}::uuid`,
      // Per-shift rows: hour buckets outside any shift schedule have no shift
      // to aggregate into (the old table had no SHIFT rows for them either).
      Prisma.sql`mb."shiftInstanceId" IS NOT NULL`,
    ];
    if (input.shiftInstanceId) {
      baseParts.push(Prisma.sql`mb."shiftInstanceId" = ${input.shiftInstanceId}::uuid`);
    }
    if (input.startDate) baseParts.push(Prisma.sql`mb."businessDate" >= ${input.startDate}::date`);
    if (input.endDate) baseParts.push(Prisma.sql`mb."businessDate" < ${input.endDate}::date + 1`);

    const stationScope = active.find((s) => s.kind === "STATION");
    const wcScope = active.find((s) => s.kind === "WORKCENTER");
    const jobScope = active.find((s) => s.kind === "JOB");

    const ctes: Prisma.Sql[] = [];
    const groupSelects: Prisma.Sql[] = [];

    // Shift context comes from the ShiftInstance itself (startTime/duration of
    // the shift window, not of the contributing hours) with row-stamp fallbacks.
    const shiftContextCols = Prisma.sql`
      COALESCE(si."shiftName", 'Shift') AS "granularityName",
      COALESCE(si."startTime", MIN(s."startTime")) AS "startTime",
      COALESCE(EXTRACT(EPOCH FROM (si."endTime" - si."startTime"))::int, SUM(s."durationSeconds")::int) AS "durationSeconds",
      s."shiftInstanceId" AS "shiftInstanceId",
      COALESCE(si."businessDate", MAX(s."businessDate")) AS "businessDate",
      COALESCE(si."shiftName", MAX(s."businessShift")) AS "businessShift"`;

    if (stationScope || wcScope) {
      const parts = [...baseParts, STATION_HOUR_PREDICATE];
      const narrowIds = stationScope?.stationIds ?? wcScope?.stationIds;
      if (narrowIds) parts.push(Prisma.sql`mb."entityId" = ANY(${narrowIds}::uuid[])`);
      ctes.push(Prisma.sql`ssrc AS (${hourUnionSourceSql(Prisma.join(parts, " AND "))})`);
    }

    if (stationScope) {
      groupSelects.push(Prisma.sql`
        SELECT
          'STATION'::text AS "entityType",
          s."entityId" AS "entityId",
          NULL::uuid AS "jobId",
          COALESCE(MAX(st."name"), MAX(s."entityName")) AS "entityName",
          MAX(s."path") AS "path",
          ${shiftContextCols},
          ${latestNonNullSql(Prisma.sql`s."currentJobName"`, Prisma.sql`s."startTime" DESC, s."updatedAt" DESC`)} AS "currentJobName",
          ${kpiSumsSql("s")},
          ${ratioSumsSql("s")}
        FROM ssrc s
        LEFT JOIN "Station" st ON st.id = s."entityId"
        LEFT JOIN "ShiftInstance" si ON si.id = s."shiftInstanceId"
        GROUP BY s."entityId", s."shiftInstanceId", si.id`);
    }

    if (wcScope) {
      groupSelects.push(Prisma.sql`
        SELECT
          'WORKCENTER'::text AS "entityType",
          st."workcenterId" AS "entityId",
          NULL::uuid AS "jobId",
          MAX(w."name") AS "entityName",
          regexp_replace(MAX(s."path"), '\\.station\\.[^.]*$', '') AS "path",
          ${shiftContextCols},
          NULL::text AS "currentJobName",
          ${kpiSumsSql("s")},
          ${ratioSumsSql("s")}
        FROM ssrc s
        JOIN "Station" st ON st.id = s."entityId"
        JOIN "Workcenter" w ON w.id = st."workcenterId"
        LEFT JOIN "ShiftInstance" si ON si.id = s."shiftInstanceId"
        ${wcScope.workCenterId ? Prisma.sql`WHERE st."workcenterId" = ${wcScope.workCenterId}::uuid` : Prisma.empty}
        GROUP BY st."workcenterId", s."shiftInstanceId", si.id`);
    }

    if (jobScope) {
      const parts = [...baseParts, JOB_HOUR_PREDICATE];
      if (jobScope.stationIds) parts.push(Prisma.sql`mb."entityId" = ANY(${jobScope.stationIds}::uuid[])`);
      ctes.push(Prisma.sql`jsrc AS (${jobDedupSql(hourUnionSourceSql(Prisma.join(parts, " AND ")))})`);
      groupSelects.push(Prisma.sql`
        SELECT
          'JOB'::text AS "entityType",
          s."entityId" AS "entityId",
          s."jobId" AS "jobId",
          COALESCE(jv."name", MAX(s."currentJobName")) AS "entityName",
          MAX(CASE WHEN s."entityType" = 'JOB' THEN s."path" ELSE s."path" || '.job.' || s."jobId"::text END) AS "path",
          ${shiftContextCols},
          ${latestNonNullSql(Prisma.sql`s."currentJobName"`, Prisma.sql`s."startTime" DESC, s."updatedAt" DESC`)} AS "currentJobName",
          ${kpiSumsSql("s")},
          ${ratioSumsSql("s")}
        FROM jsrc s
        LEFT JOIN "Job" j ON j.id = s."jobId"
        LEFT JOIN "JobVersion" jv ON jv.id = j."currentVersionId"
        LEFT JOIN "ShiftInstance" si ON si.id = s."shiftInstanceId"
        GROUP BY s."entityId", s."jobId", s."shiftInstanceId", si.id, jv."name"`);
    }

    // ── Dynamic filters, sort, pagination — all over the aggregate columns ──
    const filterSql = queryFilterToSql(input.query, METRIC_BUCKET_QUERYABLE_FIELDS);

    const dir = input.sortDir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const sortCol = input.sortBy ? METRIC_SEARCH_SORTABLE[input.sortBy] : undefined;
    const orderSql = sortCol
      ? Prisma.sql`${sortCol} ${dir}, g."entityName" ASC`
      : Prisma.sql`g."startTime" DESC, g."entityName" ASC`;

    const limit = Number(input.limit);
    const limitSql = limit > 0 ? Prisma.sql`LIMIT ${limit}` : Prisma.empty;

    const rows = await prisma.$queryRaw<MetricSearchRow[]>`
      WITH ${Prisma.join(ctes, ", ")}
      SELECT g.*, COUNT(*) OVER ()::int AS "totalCount"
      FROM (${Prisma.join(groupSelects, " UNION ALL ")}) g
      WHERE TRUE ${filterSql}
      ORDER BY ${orderSql}
      ${limitSql} OFFSET ${Number(input.offset)}
    `;

    const total = rows.length > 0 ? rows[0].totalCount : 0;
    const data = rows.map((r) => ({
      id: syntheticBucketId(r.entityType, r.entityId, r.jobId, "SHIFT", r.startTime),
      entityType: r.entityType,
      entityId: r.entityId,
      entityName: r.entityName ?? "",
      path: r.path ?? "",
      granularity: "SHIFT" as const,
      granularityName: r.granularityName ?? "",
      startTime: r.startTime,
      durationSeconds: r.durationSeconds ?? 0,
      shiftInstanceId: r.shiftInstanceId,
      businessDate: r.businessDate,
      businessShift: r.businessShift,
      currentJobName: r.currentJobName,
      totalCycles: r.totalCycles,
      goodCycles: r.goodCycles,
      badCycles: r.badCycles,
      totalItems: r.totalItems,
      goodItems: r.goodItems,
      badItems: r.badItems,
      runSeconds: r.runSeconds,
      downSeconds: r.downSeconds,
      plannedDownSeconds: r.plannedDownSeconds,
      unplannedDownSeconds: r.unplannedDownSeconds,
      expectedCycles: r.expectedCycles,
      expectedItems: r.expectedItems,
      availability: r.availability,
      performance: r.performance,
      quality: r.quality,
      oee: r.oee,
    }));

    return { data, total };
  });

// ============================================================================
// Hourly Bucket search (for white board)
//
// Returns HOUR-granularity MetricBucketLog rows for station-level production
// tracking. Used by the WhiteBoard component.
// ============================================================================

const hourlyBucketSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  shiftInstanceId: z.uuid().optional(),
});

/** Aggregate row shape shared by both hourlyBucketSearch paths. */
type HourlyAggRow = {
  entityId?: string;
  entityName?: string | null;
  granularityName: string | null;
  startTime: Date;
  durationSeconds: number;
  shiftInstanceId: string | null;
  businessDate: Date | null;
  businessShift: string | null;
  totalCycles: number;
  badCycles: number;
  goodCycles: number;
  totalItems: number;
  badItems: number;
  goodItems: number;
  expectedItems: number;
  elapsedExpectedItems: number;
  runSeconds: number;
  idealCycleSeconds: number;
  elapsedPlannedProductionSeconds: number;
  availability: Prisma.Decimal | null;
  performance: Prisma.Decimal | null;
  quality: Prisma.Decimal | null;
  oee: Prisma.Decimal | null;
};

export const hourlyBucketSearch = userOrDisplayRequired
  .input(hourlyBucketSearchInputSchema)
  .handler(async ({ input }) => {
    // Stage B: read station HOUR rows (live ∪ archived) and group per
    // station-hour, so post-cutover per-job splits collapse back to one row.
    // Workcenter rows are synthesized from the workcenter's stations.
    const baseParts: Prisma.Sql[] = [Prisma.sql`mb."siteId" = ${input.siteId}::uuid`, STATION_HOUR_PREDICATE];
    if (input.shiftInstanceId) {
      baseParts.push(Prisma.sql`mb."shiftInstanceId" = ${input.shiftInstanceId}::uuid`);
    }
    if (input.startDate) baseParts.push(Prisma.sql`mb."businessDate" >= ${input.startDate}::date`);
    if (input.endDate) baseParts.push(Prisma.sql`mb."businessDate" < ${input.endDate}::date + 1`);

    if (!input.stationId && input.workCenterId) {
      // ── Workcenter path: aggregate the workcenter's stations per hour ──
      const [stations, workcenter] = await Promise.all([
        prisma.station.findMany({
          where: { siteId: input.siteId, workcenterId: input.workCenterId },
          select: { id: true },
        }),
        prisma.workcenter.findUnique({
          where: { id: input.workCenterId },
          select: { name: true },
        }),
      ]);
      const stationIds = stations.map((s) => s.id);
      if (stationIds.length === 0) return { data: [] };
      baseParts.push(Prisma.sql`mb."entityId" = ANY(${stationIds}::uuid[])`);

      // Two-level grouping: durationSeconds is the hour window length (each
      // station's rows sum to it), so the workcenter hour takes the MAX of the
      // per-station sums instead of summing across stations.
      const rows = await prisma.$queryRaw<HourlyAggRow[]>`
        WITH src AS (${hourUnionSourceSql(Prisma.join(baseParts, " AND "))}),
        per_station AS (
          SELECT
            s."entityId",
            s."startTime",
            MAX(s."granularityName") AS "granularityName",
            MAX(s."shiftInstanceId"::text) AS "shiftInstanceId",
            MAX(s."businessDate") AS "businessDate",
            MAX(s."businessShift") AS "businessShift",
            SUM(s."durationSeconds")::int AS "durationSeconds",
            ${kpiSumsSql("s")}
          FROM src s
          GROUP BY s."entityId", s."startTime"
        )
        SELECT
          ps."startTime",
          MAX(ps."granularityName") AS "granularityName",
          MAX(ps."shiftInstanceId")::uuid AS "shiftInstanceId",
          MAX(ps."businessDate") AS "businessDate",
          MAX(ps."businessShift") AS "businessShift",
          MAX(ps."durationSeconds")::int AS "durationSeconds",
          ${kpiSumsSql("ps")},
          ${ratioSumsSql("ps")}
        FROM per_station ps
        GROUP BY ps."startTime"
        ORDER BY ps."startTime" ASC
      `;

      const workCenterId = input.workCenterId;
      return {
        data: rows.map((r) => ({
          id: syntheticBucketId("WORKCENTER", workCenterId, null, "HOUR", r.startTime),
          entityId: workCenterId,
          entityName: workcenter?.name ?? "",
          granularityName: r.granularityName ?? "Hour",
          startTime: r.startTime,
          durationSeconds: r.durationSeconds,
          shiftInstanceId: r.shiftInstanceId,
          businessDate: r.businessDate,
          businessShift: r.businessShift,
          expectedItems: r.expectedItems,
          elapsedExpectedItems: r.elapsedExpectedItems,
          totalItems: r.totalItems,
          badItems: r.badItems,
          goodItems: r.goodItems,
          availability: r.availability,
          performance: r.performance,
          quality: r.quality,
          oee: r.oee,
          runSeconds: r.runSeconds,
          elapsedPlannedProductionSeconds: r.elapsedPlannedProductionSeconds,
          idealCycleSeconds: r.idealCycleSeconds,
          totalCycles: r.totalCycles,
          goodCycles: r.goodCycles,
          badCycles: r.badCycles,
        })),
      };
    }

    // ── Station path: one row per station-hour ──
    if (input.stationId) {
      baseParts.push(Prisma.sql`mb."entityId" = ${input.stationId}::uuid`);
    }

    const rows = await prisma.$queryRaw<HourlyAggRow[]>`
      WITH src AS (${hourUnionSourceSql(Prisma.join(baseParts, " AND "))})
      SELECT
        s."entityId",
        MAX(s."entityName") AS "entityName",
        MAX(s."granularityName") AS "granularityName",
        s."startTime",
        SUM(s."durationSeconds")::int AS "durationSeconds",
        MAX(s."shiftInstanceId"::text)::uuid AS "shiftInstanceId",
        MAX(s."businessDate") AS "businessDate",
        MAX(s."businessShift") AS "businessShift",
        ${kpiSumsSql("s")},
        ${ratioSumsSql("s")}
      FROM src s
      GROUP BY s."entityId", s."startTime"
      ORDER BY s."startTime" ASC, "entityName" ASC
    `;

    return {
      data: rows.map((r) => ({
        id: syntheticBucketId("STATION", r.entityId as string, null, "HOUR", r.startTime),
        entityId: r.entityId as string,
        entityName: r.entityName ?? "",
        granularityName: r.granularityName ?? "Hour",
        startTime: r.startTime,
        durationSeconds: r.durationSeconds,
        shiftInstanceId: r.shiftInstanceId,
        businessDate: r.businessDate,
        businessShift: r.businessShift,
        expectedItems: r.expectedItems,
        elapsedExpectedItems: r.elapsedExpectedItems,
        totalItems: r.totalItems,
        badItems: r.badItems,
        goodItems: r.goodItems,
        availability: r.availability,
        performance: r.performance,
        quality: r.quality,
        oee: r.oee,
        runSeconds: r.runSeconds,
        elapsedPlannedProductionSeconds: r.elapsedPlannedProductionSeconds,
        idealCycleSeconds: r.idealCycleSeconds,
        totalCycles: r.totalCycles,
        goodCycles: r.goodCycles,
        badCycles: r.badCycles,
      })),
    };
  });

// ============================================================================
// Station Shift Summary (for white board sidebar)
//
// Returns a single SHIFT-granularity bucket for one station + shift, with the
// MetricBucket fallback for current/active shifts.
// ============================================================================

const stationShiftSummaryInputSchema = z.object({
  siteId: z.uuid(),
  stationId: z.uuid(),
  shiftInstanceId: z.uuid(),
});

export const stationShiftSummary = authRequired.input(stationShiftSummaryInputSchema).handler(async ({ input }) => {
  // Stage B: the shift summary is aggregated from the station's HOUR rows for
  // the shift (live ∪ archived) instead of reading the SHIFT-tier bucket.
  const predicate = Prisma.sql`mb."siteId" = ${input.siteId}::uuid
    AND ${STATION_HOUR_PREDICATE}
    AND mb."entityId" = ${input.stationId}::uuid
    AND mb."shiftInstanceId" = ${input.shiftInstanceId}::uuid`;

  type SummaryRow = {
    rowCount: number;
    startTime: Date | null;
    durationSeconds: number | null;
    entityName: string | null;
    businessDate: Date | null;
    businessShift: string | null;
    currentJobName: string | null;
    currentStandardCycle: Prisma.Decimal | null;
    expectedItems: number | null;
    totalItems: number | null;
    goodItems: number | null;
    badItems: number | null;
    expectedCycles: number | null;
    totalCycles: number | null;
    goodCycles: number | null;
    badCycles: number | null;
    runSeconds: number | null;
    downSeconds: number | null;
    plannedDownSeconds: number | null;
    unplannedDownSeconds: number | null;
    idealCycleSeconds: number | null;
    elapsedPlannedProductionSeconds: number | null;
    availability: Prisma.Decimal | null;
    performance: Prisma.Decimal | null;
    quality: Prisma.Decimal | null;
    oee: Prisma.Decimal | null;
  };

  const rows = await prisma.$queryRaw<SummaryRow[]>`
    WITH src AS (${hourUnionSourceSql(predicate)})
    SELECT
      COUNT(*)::int AS "rowCount",
      MIN(s."startTime") AS "startTime",
      SUM(s."durationSeconds")::int AS "durationSeconds",
      MAX(s."entityName") AS "entityName",
      MAX(s."businessDate") AS "businessDate",
      MAX(s."businessShift") AS "businessShift",
      ${latestNonNullSql(Prisma.sql`s."currentJobName"`, Prisma.sql`s."startTime" DESC, s."updatedAt" DESC`)} AS "currentJobName",
      ${latestNonNullSql(Prisma.sql`s."currentStandardCycle"`, Prisma.sql`s."startTime" DESC, s."updatedAt" DESC`)} AS "currentStandardCycle",
      ${kpiSumsSql("s")},
      ${ratioSumsSql("s")}
    FROM src s
  `;

  const r = rows[0];
  if (!r || r.rowCount === 0 || r.startTime === null) return { data: null };

  return {
    data: {
      id: syntheticBucketId("STATION", input.stationId, null, "SHIFT", r.startTime),
      entityType: "STATION" as const,
      entityId: input.stationId,
      entityName: r.entityName ?? "",
      startTime: r.startTime,
      durationSeconds: r.durationSeconds ?? 0,
      businessDate: r.businessDate,
      businessShift: r.businessShift,
      currentJobName: r.currentJobName,
      currentStandardCycle: r.currentStandardCycle,
      expectedItems: r.expectedItems ?? 0,
      totalItems: r.totalItems ?? 0,
      goodItems: r.goodItems ?? 0,
      badItems: r.badItems ?? 0,
      expectedCycles: r.expectedCycles ?? 0,
      totalCycles: r.totalCycles ?? 0,
      goodCycles: r.goodCycles ?? 0,
      badCycles: r.badCycles ?? 0,
      runSeconds: r.runSeconds ?? 0,
      downSeconds: r.downSeconds ?? 0,
      plannedDownSeconds: r.plannedDownSeconds ?? 0,
      unplannedDownSeconds: r.unplannedDownSeconds ?? 0,
      idealCycleSeconds: r.idealCycleSeconds ?? 0,
      elapsedPlannedProductionSeconds: r.elapsedPlannedProductionSeconds ?? 0,
      availability: r.availability,
      performance: r.performance,
      quality: r.quality,
      oee: r.oee,
    },
  };
});

// ============================================================================
// Downtime Log search (stamped attribution, paginated)
//
// Rows stamped at write time (shiftInstanceId/businessDate columns) already
// lie within a single shift — they are attributed directly from the stamps.
// Legacy rows with NULL stamps fall back to the in-memory shift clamp: each
// entry is cross-joined with overlapping shift instances so a single entry
// that spans two shifts produces two rows, each clamped to the shift's time
// boundaries. Raw entries when no shifts exist.
// ============================================================================

const downtimeLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const downtimeLogSearch = authRequired.input(downtimeLogSearchInputSchema).handler(async ({ input }) => {
  // Resolve station IDs for the scope
  let stationIds: string[];
  let stationWorkcenterMap: Map<string, string | null>;

  if (input.stationId) {
    const st = await prisma.station.findUnique({
      where: { id: input.stationId },
      select: { id: true, workcenterId: true },
    });
    stationIds = st ? [st.id] : [];
    stationWorkcenterMap = new Map(st ? [[st.id, st.workcenterId]] : []);
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true, workcenterId: true },
    });
    stationIds = stations.map((s) => s.id);
    stationWorkcenterMap = new Map(stations.map((s) => [s.id, s.workcenterId]));
  } else {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId },
      select: { id: true, workcenterId: true },
    });
    stationIds = stations.map((s) => s.id);
    stationWorkcenterMap = new Map(stations.map((s) => [s.id, s.workcenterId]));
  }

  if (stationIds.length === 0) {
    return { data: [], total: 0 };
  }

  // Compute time range from date filters
  const rangeStart = input.startDate ? new Date(input.startDate) : new Date("2000-01-01");
  const rangeEnd = input.endDate
    ? (() => {
        const d = new Date(input.endDate);
        d.setDate(d.getDate() + 1);
        return d;
      })()
    : new Date("2100-01-01");

  // Fetch overlapping DOWN entries (exclude open entries — they're still in progress)
  const downtimeWhere: Record<string, unknown> = {
    state: "DOWN",
    deletedAt: null,
    stationId: stationIds.length === 1 ? stationIds[0] : { in: stationIds },
    startTime: { lt: rangeEnd },
    endTime: { gt: rangeStart },
  };

  const entrySelect = {
    id: true,
    stationId: true,
    startTime: true,
    endTime: true,
    shiftInstanceId: true,
    shiftInstance: { select: { shiftName: true } },
    businessDate: true,
    statusReasonId: true,
    statusReason: {
      select: {
        id: true,
        name: true,
        isPlannedDown: true,
        category: { select: { id: true, name: true } },
      },
    },
    station: { select: { name: true, workcenterId: true } },
    jobVersionId: true,
    jobVersion: { select: { id: true, name: true } },
  };

  const entries = await prisma.stationStateLog.findMany({
    where: downtimeWhere,
    select: entrySelect,
    orderBy: { startTime: "asc" },
  });

  // Stamped rows (write-time shift context) are attributed directly; only
  // rows with NULL stamps (legacy, pre-split) need the clamp fallback.
  const stampedEntries = entries.filter((e) => e.shiftInstanceId != null);
  const legacyEntries = entries.filter((e) => e.shiftInstanceId == null);

  // Fetch shift instances overlapping the range (clamp fallback only)
  const shiftInstances =
    legacyEntries.length === 0
      ? []
      : await prisma.shiftInstance.findMany({
          where: {
            OR: [
              { siteId: input.siteId, workCenterId: null },
              ...(input.workCenterId
                ? [{ workCenterId: input.workCenterId }]
                : [...new Set(stationWorkcenterMap.values())]
                    .filter((id): id is string => id != null)
                    .map((wcId) => ({ workCenterId: wcId }))),
            ],
            startTime: { lt: rangeEnd },
            endTime: { gt: rangeStart },
          },
          select: {
            id: true,
            shiftName: true,
            businessDate: true,
            startTime: true,
            endTime: true,
            workCenterId: true,
          },
          orderBy: { startTime: "asc" },
        });

  // Build result rows
  const rows: Array<{
    id: string;
    stationId: string;
    stationName: string;
    shiftName: string | null;
    businessDate: Date | null;
    startTime: Date;
    endTime: Date | null;
    durationSeconds: number | null;
    statusReasonId: string | null;
    statusReasonName: string | null;
    isPlannedDown: boolean | null;
    categoryName: string | null;
    jobVersionId: string | null;
    jobName: string | null;
  }> = [];

  // Stamped rows: split at shift boundaries at write time, so the row lies
  // within one shift — no clamping, attribution comes from the columns.
  for (const entry of stampedEntries) {
    if (!entry.endTime) continue;
    rows.push({
      id: entry.id,
      stationId: entry.stationId,
      stationName: entry.station.name,
      shiftName: entry.shiftInstance?.shiftName ?? null,
      businessDate: entry.businessDate,
      startTime: entry.startTime,
      endTime: entry.endTime,
      durationSeconds: Math.round((entry.endTime.getTime() - entry.startTime.getTime()) / 1000),
      statusReasonId: entry.statusReasonId,
      statusReasonName: entry.statusReason?.name ?? null,
      isPlannedDown: entry.statusReason?.isPlannedDown ?? null,
      categoryName: entry.statusReason?.category?.name ?? null,
      jobVersionId: entry.jobVersionId ?? null,
      jobName: entry.jobVersion?.name ?? null,
    });
  }

  if (shiftInstances.length > 0) {
    // Clamp fallback: cross-join legacy entries with overlapping shifts
    const shiftsByWc = new Map<string | null, typeof shiftInstances>();
    for (const si of shiftInstances) {
      const key = si.workCenterId;
      if (!shiftsByWc.has(key)) shiftsByWc.set(key, []);
      shiftsByWc.get(key)?.push(si);
    }

    for (const entry of legacyEntries) {
      if (!entry.endTime) continue;
      const entryEnd = entry.endTime;
      const wcId = entry.station.workcenterId;
      const applicableShifts = shiftsByWc.get(wcId) ?? shiftsByWc.get(null) ?? [];

      for (const shift of applicableShifts) {
        if (entry.startTime >= shift.endTime || entryEnd <= shift.startTime) continue;

        const clampedStart = entry.startTime < shift.startTime ? shift.startTime : entry.startTime;
        const clampedEnd = entryEnd > shift.endTime ? shift.endTime : entryEnd;
        const durationSeconds = Math.round((clampedEnd.getTime() - clampedStart.getTime()) / 1000);
        if (durationSeconds <= 0) continue;

        rows.push({
          id: `${entry.id}:${shift.id}`,
          stationId: entry.stationId,
          stationName: entry.station.name,
          shiftName: shift.shiftName,
          businessDate: shift.businessDate,
          startTime: clampedStart,
          endTime: clampedEnd,
          durationSeconds,
          statusReasonId: entry.statusReasonId,
          statusReasonName: entry.statusReason?.name ?? null,
          isPlannedDown: entry.statusReason?.isPlannedDown ?? null,
          categoryName: entry.statusReason?.category?.name ?? null,
          jobVersionId: entry.jobVersionId ?? null,
          jobName: entry.jobVersion?.name ?? null,
        });
      }
    }
  } else {
    // No shifts configured — fall back to raw entries
    for (const entry of legacyEntries) {
      const durationSeconds = entry.endTime
        ? Math.round((entry.endTime.getTime() - entry.startTime.getTime()) / 1000)
        : null;

      rows.push({
        id: entry.id,
        stationId: entry.stationId,
        stationName: entry.station.name,
        shiftName: null,
        businessDate: entry.businessDate,
        startTime: entry.startTime,
        endTime: entry.endTime,
        durationSeconds,
        statusReasonId: entry.statusReasonId,
        statusReasonName: entry.statusReason?.name ?? null,
        isPlannedDown: entry.statusReason?.isPlannedDown ?? null,
        categoryName: entry.statusReason?.category?.name ?? null,
        jobVersionId: entry.jobVersionId ?? null,
        jobName: entry.jobVersion?.name ?? null,
      });
    }
  }

  // Dynamic query builder filters (in-memory, validated against allowlist)
  let filteredRows = rows;
  if (input.query) {
    const predicate = toRowFilter(input.query, DOWNTIME_QUERYABLE_FIELDS);
    filteredRows = rows.filter(predicate);
  }

  // Sort
  type Row = (typeof filteredRows)[number];
  const SORTABLE: Record<string, (r: Row) => string | number> = {
    startTime: (r) => r.startTime.getTime(),
    endTime: (r) => r.endTime?.getTime() ?? 0,
    stationName: (r) => r.stationName,
    shiftName: (r) => r.shiftName ?? "",
    businessDate: (r) => r.businessDate?.getTime() ?? 0,
    durationSeconds: (r) => r.durationSeconds ?? 0,
    statusReasonName: (r) => r.statusReasonName ?? "",
    categoryName: (r) => r.categoryName ?? "",
    jobName: (r) => r.jobName ?? "",
  };

  const sortKey = input.sortBy && SORTABLE[input.sortBy] ? SORTABLE[input.sortBy] : SORTABLE.startTime;
  const sortMul = input.sortDir === "asc" ? 1 : -1;

  filteredRows.sort((a, b) => {
    const va = sortKey(a);
    const vb = sortKey(b);
    if (va < vb) return -1 * sortMul;
    if (va > vb) return 1 * sortMul;
    return 0;
  });

  // Paginate
  const total = filteredRows.length;
  const offset = Number(input.offset);
  const limit = Number(input.limit);
  const page = limit > 0 ? filteredRows.slice(offset, offset + limit) : filteredRows;

  return { data: page, total };
});

// ============================================================================
// Disposition Log search (paginated, filterable)
// ============================================================================

const dispositionLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const dispositionLogSearch = authRequired.input(dispositionLogSearchInputSchema).handler(async ({ input }) => {
  const where: Prisma.ItemDispositionLogWhereInput = {
    siteId: input.siteId,
    deletedAt: null,
  };

  // Scope by station or workcenter
  if (input.stationId) {
    where.stationId = input.stationId;
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    where.stationId = { in: stations.map((s) => s.id) };
  }

  // Date range on createdAt
  if (input.startDate || input.endDate) {
    const dateFilter: Record<string, Date> = {};
    if (input.startDate) dateFilter.gte = new Date(input.startDate);
    if (input.endDate) {
      const end = new Date(input.endDate);
      end.setDate(end.getDate() + 1);
      dateFilter.lt = end;
    }
    where.createdAt = dateFilter;
  }

  // Dynamic query builder filters
  if (input.query) {
    const dynamicWhere = toPrismaWhere(
      input.query,
      DISPOSITION_LOG_QUERYABLE_FIELDS,
    ) as Prisma.ItemDispositionLogWhereInput;
    if (Object.keys(dynamicWhere).length > 0) {
      where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), dynamicWhere];
    }
  }

  const select = {
    id: true,
    createdAt: true,
    quantity: true,
    stationId: true,
    station: { select: { id: true, name: true } },
    itemDisposition: { select: { id: true, name: true } },
    dispositionReason: { select: { id: true, name: true } },
    productVersion: { select: { id: true, name: true, sku: true } },
    toolVersion: { select: { id: true, name: true } },
    toolCavityVersion: { select: { id: true, name: true } },
    shiftInstance: { select: { id: true, shiftName: true, businessDate: true } },
  };

  const SORTABLE_COLUMNS = new Set(["createdAt", "quantity"]);

  // For relation fields, we need to map to the correct orderBy shape
  type OrderBy = Prisma.ItemDispositionLogOrderByWithRelationInput;
  const RELATION_SORT: Record<string, OrderBy> = {
    stationName: { station: { name: input.sortDir } },
    dispositionName: { itemDisposition: { name: input.sortDir } },
    reasonName: { dispositionReason: { name: input.sortDir } },
    productName: { productVersion: { name: input.sortDir } },
    shiftName: { shiftInstance: { shiftName: input.sortDir } },
  };

  let orderBy: OrderBy[];
  if (input.sortBy && SORTABLE_COLUMNS.has(input.sortBy)) {
    orderBy = [{ [input.sortBy]: input.sortDir }, { createdAt: "desc" }];
  } else if (input.sortBy && RELATION_SORT[input.sortBy]) {
    orderBy = [RELATION_SORT[input.sortBy], { createdAt: "desc" }];
  } else {
    orderBy = [{ createdAt: "desc" }];
  }

  const [data, total] = await Promise.all([
    prisma.itemDispositionLog.findMany({
      where,
      select,
      orderBy,
      ...(Number(input.limit) > 0 ? { take: Number(input.limit) } : {}),
      skip: Number(input.offset),
    }),
    prisma.itemDispositionLog.count({ where }),
  ]);

  // Flatten for the frontend
  const rows = data.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    quantity: row.quantity,
    stationId: row.stationId,
    stationName: row.station.name,
    dispositionName: row.itemDisposition?.name ?? null,
    reasonName: row.dispositionReason?.name ?? null,
    productName: row.productVersion?.name ?? null,
    productSku: row.productVersion?.sku ?? null,
    toolName: row.toolVersion?.name ?? null,
    cavityName: row.toolCavityVersion?.name ?? null,
    shiftName: row.shiftInstance?.shiftName ?? null,
    businessDate: row.shiftInstance?.businessDate ?? null,
  }));

  return { data: rows, total };
});

// ============================================================================
// Material Usage Log search (aggregated, paginated)
//
// Joins InventoryItem → ProductMaterialVersion (weight) → MaterialVersion (name),
// plus Cycle → JobVersion (job name) and ProductVersion (part name).
// Cross-references with ShiftInstances for shift/date attribution.
// Aggregates (sums) weight by Date, Shift, Job, Part, Material.
// ============================================================================

/** Material usage rows are computed in JS, so we filter in-memory. */
const MATERIAL_USAGE_QUERYABLE_FIELDS: FieldAllowlist = {
  businessDate: { column: "businessDate", type: "string" },
  shiftName: { column: "shiftName", type: "string" },
  jobName: { column: "jobName", type: "string" },
  partName: { column: "partName", type: "string" },
  materialName: { column: "materialName", type: "string" },
  totalWeight: { column: "totalWeight", type: "number" },
  weightUnits: { column: "weightUnits", type: "string" },
  itemCount: { column: "itemCount", type: "number" },
};

const materialUsageSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  groupByJob: z.boolean().default(true),
  groupByPart: z.boolean().default(true),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const materialUsageSearch = authRequired.input(materialUsageSearchInputSchema).handler(async ({ input }) => {
  // Station scope (workcenter filter only — site scoping happens in SQL)
  let stationIds: string[] | undefined;
  if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    stationIds = stations.map((s) => s.id);
    if (stationIds.length === 0) return { data: [], total: 0 };
  }

  // Date range for cycle.end
  const rangeStart = input.startDate ? new Date(input.startDate) : new Date("2000-01-01");
  const rangeEnd = input.endDate
    ? (() => {
        const d = new Date(input.endDate);
        d.setDate(d.getDate() + 1);
        return d;
      })()
    : new Date("2100-01-01");

  // One SQL aggregation grouped by IDs (job/product/material parents), never
  // by snapshotted name strings — re-versions must not split rows and name
  // collisions must not merge them. Shift/date attribution comes from the
  // stamped context columns (item first, cycle fallback); rows predating the
  // backfill fall back to the UTC calendar date with a NULL shift. Labels
  // resolve through parent → currentVersion, snapshot as last resort.
  const jobKey = input.groupByJob ? Prisma.sql`COALESCE(ii."jobId", c."jobId")` : Prisma.sql`NULL::uuid`;
  const jobLabel = input.groupByJob ? Prisma.sql`MAX(COALESCE(jbv."name", jvs."name"))` : Prisma.sql`NULL`;
  const partKey = input.groupByPart ? Prisma.sql`COALESCE(ii."productId"::text, pvs."name", '*')` : Prisma.sql`'*'`;
  const partLabel = input.groupByPart ? Prisma.sql`MAX(COALESCE(pcv."name", pvs."name", '—'))` : Prisma.sql`NULL`;
  const stationFilter = stationIds ? Prisma.sql`AND c."stationId" = ANY(${stationIds}::uuid[])` : Prisma.empty;

  type UsageAggRow = {
    businessDate: string | null;
    shiftName: string | null;
    jobName: string | null;
    partName: string | null;
    materialName: string;
    weightUnits: string | null;
    totalWeight: number;
    itemCount: number;
  };

  const aggRows = await prisma.$queryRaw<UsageAggRow[]>`
    SELECT
      COALESCE(
        to_char(COALESCE(ii."businessDate", c."businessDate"), 'YYYY-MM-DD'),
        to_char((COALESCE(c."end", c.start) AT TIME ZONE 'UTC'), 'YYYY-MM-DD')
      )                                            AS "businessDate",
      MAX(si."shiftName")                          AS "shiftName",
      ${jobLabel}                                  AS "jobName",
      ${partLabel}                                 AS "partName",
      MAX(COALESCE(mcv."name", mv."name", '—'))    AS "materialName",
      pmv."weightUnits"::text                      AS "weightUnits",
      ROUND(SUM(COALESCE(pmv."weight", 0))::numeric, 2)::float8 AS "totalWeight",
      COUNT(*)::int                                AS "itemCount"
    FROM "InventoryItem" ii
    JOIN "Cycle" c ON c.id = ii."cycleId"
    JOIN "_InventoryItemToProductMaterialVersion" l ON l."A" = ii.id
    JOIN "ProductMaterialVersion" pmv ON pmv.id = l."B"
    JOIN "MaterialVersion" mv ON mv.id = pmv."materialVersionId"
    LEFT JOIN "Material" mat ON mat.id = mv."materialId"
    LEFT JOIN "MaterialVersion" mcv ON mcv.id = mat."currentVersionId"
    LEFT JOIN "ShiftInstance" si ON si.id = COALESCE(ii."shiftInstanceId", c."shiftInstanceId")
    LEFT JOIN "Job" jb ON jb.id = COALESCE(ii."jobId", c."jobId") AND ${input.groupByJob ?? false}
    LEFT JOIN "JobVersion" jbv ON jbv.id = jb."currentVersionId"
    LEFT JOIN "JobVersion" jvs ON jvs.id = c."jobVersionId" AND ${input.groupByJob ?? false}
    LEFT JOIN "ProductVersion" pvs ON pvs.id = ii."productVersionId" AND ${input.groupByPart ?? false}
    LEFT JOIN "Product" p ON p.id = ii."productId" AND ${input.groupByPart ?? false}
    LEFT JOIN "ProductVersion" pcv ON pcv.id = p."currentVersionId"
    WHERE c."siteId" = ${input.siteId}::uuid
      AND c."deletedAt" IS NULL
      AND ii."deletedAt" IS NULL
      AND c."end" >= ${rangeStart} AND c."end" < ${rangeEnd}
      ${stationFilter}
    GROUP BY 1, COALESCE(ii."shiftInstanceId", c."shiftInstanceId"), ${jobKey}, ${partKey},
      mv."materialId", pmv."weightUnits"
  `;

  let rows: UsageAggRow[] = aggRows;

  // Dynamic query builder filters (in-memory)
  if (input.query) {
    const predicate = toRowFilter(input.query, MATERIAL_USAGE_QUERYABLE_FIELDS);
    rows = rows.filter(predicate);
  }

  // Sort
  type Row = (typeof rows)[number];
  const SORTABLE: Record<string, (r: Row) => string | number> = {
    businessDate: (r) => r.businessDate ?? "",
    shiftName: (r) => r.shiftName ?? "",
    jobName: (r) => r.jobName ?? "",
    partName: (r) => r.partName ?? "",
    materialName: (r) => r.materialName,
    totalWeight: (r) => r.totalWeight,
    weightUnits: (r) => r.weightUnits ?? "",
    itemCount: (r) => r.itemCount,
  };

  const sortKey = input.sortBy && SORTABLE[input.sortBy] ? SORTABLE[input.sortBy] : SORTABLE.businessDate;
  const sortMul = input.sortDir === "asc" ? 1 : -1;

  rows.sort((a, b) => {
    const va = sortKey(a);
    const vb = sortKey(b);
    if (va < vb) return -1 * sortMul;
    if (va > vb) return 1 * sortMul;
    return 0;
  });

  // Paginate
  const total = rows.length;
  const offset = Number(input.offset);
  const limit = Number(input.limit);
  const page = limit > 0 ? rows.slice(offset, offset + limit) : rows;

  return { data: page, total };
});

// ============================================================================
// Cycle Log search (paginated, filterable)
//
// Returns individual cycle records with job name, station name, standard cycle,
// actual cycle duration, and shift/date attribution via ShiftInstance overlap.
//
// All work is server-side: a single $queryRaw with two LEFT JOIN LATERAL
// subqueries (workcenter-scoped + site-fallback) attributes each cycle to its
// shift, plus a window function for total count alongside the paginated page.
// Filter and sort on shiftName / businessDate operate on the COALESCE'd
// attributed values. The previous implementation loaded every cycle into
// memory and 502'd at production volume.
// ============================================================================

const cycleSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

/** Fields from the CTE that the dynamic query / sortBy can reference. */
const CYCLE_FIELD_TO_SQL: Record<string, Prisma.Sql> = {
  stationName: Prisma.sql`"stationName"`,
  jobName: Prisma.sql`"jobName"`,
  cycleStatus: Prisma.sql`"cycleStatus"`,
  standardCycle: Prisma.sql`"standardCycle"`,
  shiftName: Prisma.sql`"shiftName"`,
  businessDate: Prisma.sql`"businessDate"`,
  startTime: Prisma.sql`"startTime"`,
  endTime: Prisma.sql`"endTime"`,
};

export const cycleSearch = authRequired.input(cycleSearchInputSchema).handler(async ({ input }) => {
  // Resolve station scope to a uuid[] we can ANY() in SQL.
  let stationIds: string[];
  if (input.stationId) {
    const st = await prisma.station.findUnique({
      where: { id: input.stationId },
      select: { id: true },
    });
    stationIds = st ? [st.id] : [];
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    stationIds = stations.map((s) => s.id);
  } else {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId },
      select: { id: true },
    });
    stationIds = stations.map((s) => s.id);
  }

  if (stationIds.length === 0) {
    return { data: [], total: 0 };
  }

  // Default to last 7 days when no startDate is supplied. The previous
  // "2000-01-01" default loaded every cycle ever for the site at
  // production volume, blowing up the response.
  const rangeStart = input.startDate ? new Date(input.startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rangeEnd = input.endDate
    ? (() => {
        const d = new Date(input.endDate);
        d.setDate(d.getDate() + 1);
        return d;
      })()
    : new Date();

  const filterFragment = buildCycleFilterSql(input.query);
  const orderFragment = buildCycleOrderBySql(input.sortBy, input.sortDir);

  const limit = Number(input.limit);
  const take = limit > 0 ? limit : 50;
  const skip = Number(input.offset);

  type Row = {
    id: string;
    cycleStatus: "GOOD" | "BAD" | "DISCARD";
    startTime: Date;
    endTime: Date | null;
    stationId: string;
    stationName: string;
    jobName: string | null;
    standardCycle: number | null;
    actualCycleSeconds: number | null;
    shiftName: string | null;
    businessDate: string | null;
    totalCount: bigint;
  };

  const rows = await prisma.$queryRaw<Row[]>`
    WITH attributed AS (
      SELECT
        c.id,
        c."cycleStatus",
        c.start            AS "startTime",
        c."end"            AS "endTime",
        c."stationId",
        s.name             AS "stationName",
        jb.name            AS "jobName",
        jb."standardCycle"::float8 AS "standardCycle",
        CASE
          WHEN c."end" IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM (c."end" - c.start))::int
        END                AS "actualCycleSeconds",
        COALESCE(si_stamped."shiftName", si_wc."shiftName", si_site."shiftName") AS "shiftName",
        COALESCE(
          to_char(c."businessDate", 'YYYY-MM-DD'),
          to_char(si_wc."businessDate", 'YYYY-MM-DD'),
          to_char(si_site."businessDate", 'YYYY-MM-DD')
        )                  AS "businessDate"
      FROM "Cycle" c
      JOIN "Station" s ON s.id = c."stationId"
      JOIN "JobVersion" jb ON jb.id = c."jobVersionId"
      -- Stamped attribution (write-time context). The LATERAL overlap joins
      -- below run only for legacy rows with no stamp; drop them once the
      -- backfill has landed everywhere.
      LEFT JOIN "ShiftInstance" si_stamped ON si_stamped.id = c."shiftInstanceId"
      LEFT JOIN LATERAL (
        SELECT si."shiftName", si."businessDate"
        FROM "ShiftInstance" si
        WHERE c."shiftInstanceId" IS NULL
          AND si."workCenterId" = s."workcenterId"
          AND si."startTime" <= c.start
          AND si."endTime"   >  c.start
        ORDER BY si."startTime" DESC
        LIMIT 1
      ) si_wc ON TRUE
      LEFT JOIN LATERAL (
        SELECT si."shiftName", si."businessDate"
        FROM "ShiftInstance" si
        WHERE c."shiftInstanceId" IS NULL
          AND si."siteId" = c."siteId"
          AND si."workCenterId" IS NULL
          AND si."startTime" <= c.start
          AND si."endTime"   >  c.start
        ORDER BY si."startTime" DESC
        LIMIT 1
      ) si_site ON TRUE
      WHERE c."siteId" = ${input.siteId}::uuid
        AND c."deletedAt" IS NULL
        AND c.start >= ${rangeStart}::timestamptz
        AND c.start <  ${rangeEnd}::timestamptz
        AND c."stationId" = ANY(${stationIds}::uuid[])
    )
    SELECT
      a.*,
      COUNT(*) OVER () AS "totalCount"
    FROM attributed a
    WHERE TRUE ${filterFragment}
    ORDER BY ${orderFragment}
    LIMIT ${take} OFFSET ${skip}
  `;

  const total = rows.length > 0 ? Number(rows[0].totalCount) : 0;
  const data = rows.map(({ totalCount: _t, ...rest }) => rest);
  return { data, total };
});

// ---------------------------------------------------------------------------
// Cycle filter / sort SQL builders
// ---------------------------------------------------------------------------

function buildCycleFilterSql(query: QueryFilter | undefined): Prisma.Sql {
  if (!query) return Prisma.empty;
  const expr = walkQueryToSql(query);
  // The outer SELECT already starts with `WHERE TRUE`, so every emitted
  // expression hangs off an `AND`.
  return expr.values.length > 0 || expr.text.length > 0 ? Prisma.sql`AND (${expr})` : Prisma.empty;
}

function walkQueryToSql(node: QueryFilter | QueryRule): Prisma.Sql {
  // Group node (and / or)
  if ("combinator" in node) {
    const parts = node.rules.map(walkQueryToSql).filter((p) => p.text.length > 0 || p.values.length > 0);
    if (parts.length === 0) return Prisma.sql`TRUE`;
    const sep = node.combinator === "and" ? " AND " : " OR ";
    return Prisma.sql`(${Prisma.join(parts, sep)})`;
  }
  // Term node
  return termToSql(node);
}

function termToSql(rule: QueryRule): Prisma.Sql {
  const col = CYCLE_FIELD_TO_SQL[rule.field];
  if (!col) return Prisma.sql`TRUE`; // unknown field — silent no-op (parity with prior allowlist behavior)

  switch (rule.operator) {
    case "=":
      return Prisma.sql`${col} = ${rule.value}`;
    case "!=":
      return Prisma.sql`${col} <> ${rule.value}`;
    case ">":
      return Prisma.sql`${col} > ${rule.value}`;
    case "<":
      return Prisma.sql`${col} < ${rule.value}`;
    case ">=":
      return Prisma.sql`${col} >= ${rule.value}`;
    case "<=":
      return Prisma.sql`${col} <= ${rule.value}`;
    case "contains":
      return Prisma.sql`${col} ILIKE ${`%${String(rule.value)}%`}`;
    case "beginsWith":
      return Prisma.sql`${col} ILIKE ${`${String(rule.value)}%`}`;
    case "in":
      if (!Array.isArray(rule.value) || rule.value.length === 0) return Prisma.sql`FALSE`;
      return Prisma.sql`${col} IN (${Prisma.join(rule.value)})`;
    case "notIn":
      if (!Array.isArray(rule.value) || rule.value.length === 0) return Prisma.sql`TRUE`;
      return Prisma.sql`${col} NOT IN (${Prisma.join(rule.value)})`;
    case "between":
      if (!Array.isArray(rule.value) || rule.value.length !== 2) return Prisma.sql`TRUE`;
      return Prisma.sql`${col} BETWEEN ${rule.value[0]} AND ${rule.value[1]}`;
    case "notBetween":
      if (!Array.isArray(rule.value) || rule.value.length !== 2) return Prisma.sql`TRUE`;
      return Prisma.sql`${col} NOT BETWEEN ${rule.value[0]} AND ${rule.value[1]}`;
    case "null":
      return Prisma.sql`${col} IS NULL`;
    case "notNull":
      return Prisma.sql`${col} IS NOT NULL`;
    default:
      return Prisma.sql`TRUE`;
  }
}

function buildCycleOrderBySql(sortBy: string | undefined, sortDir: "asc" | "desc"): Prisma.Sql {
  const col = sortBy ? CYCLE_FIELD_TO_SQL[sortBy] : null;
  const dir = sortDir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  if (col) {
    return Prisma.sql`${col} ${dir} NULLS LAST`;
  }
  return Prisma.sql`"startTime" DESC`;
}

// ============================================================================
// Logon Log search (paginated, filterable) — StationLogonSession history
// ============================================================================

const logonLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const logonLogSearch = authRequired.input(logonLogSearchInputSchema).handler(async ({ input }) => {
  const where: Prisma.StationLogonSessionWhereInput = {
    station: { siteId: input.siteId },
  };

  if (input.stationId) {
    where.stationId = input.stationId;
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    where.stationId = { in: stations.map((s) => s.id) };
  }

  if (input.startDate || input.endDate) {
    const dateFilter: Record<string, Date> = {};
    if (input.startDate) dateFilter.gte = new Date(input.startDate);
    if (input.endDate) {
      const end = new Date(input.endDate);
      end.setDate(end.getDate() + 1);
      dateFilter.lt = end;
    }
    where.logonTime = dateFilter;
  }

  if (input.query) {
    const dynamicWhere = toPrismaWhere(input.query, LOGON_LOG_QUERYABLE_FIELDS) as Prisma.StationLogonSessionWhereInput;
    if (Object.keys(dynamicWhere).length > 0) {
      where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), dynamicWhere];
    }
  }

  const select = {
    id: true,
    logonTime: true,
    logoffTime: true,
    logonMethod: true,
    genericName: true,
    stationId: true,
    station: { select: { id: true, name: true } },
    display: { select: { id: true, name: true } },
    employee: {
      select: {
        id: true,
        version: { select: { firstName: true, lastName: true, employeeNumber: true } },
      },
    },
    shiftInstance: { select: { id: true, shiftName: true, businessDate: true } },
  };

  const SORTABLE_COLUMNS = new Set(["logonTime", "logoffTime", "logonMethod"]);

  type OrderBy = Prisma.StationLogonSessionOrderByWithRelationInput;
  const RELATION_SORT: Record<string, OrderBy> = {
    stationName: { station: { name: input.sortDir } },
    displayName: { display: { name: input.sortDir } },
    shiftName: { shiftInstance: { shiftName: input.sortDir } },
    employeeName: { employee: { version: { lastName: input.sortDir } } },
    employeeNumber: { employee: { version: { employeeNumber: input.sortDir } } },
  };

  let orderBy: OrderBy[];
  if (input.sortBy && SORTABLE_COLUMNS.has(input.sortBy)) {
    orderBy = [{ [input.sortBy]: input.sortDir }, { logonTime: "desc" }];
  } else if (input.sortBy && RELATION_SORT[input.sortBy]) {
    orderBy = [RELATION_SORT[input.sortBy], { logonTime: "desc" }];
  } else {
    orderBy = [{ logonTime: "desc" }];
  }

  const [data, total] = await Promise.all([
    prisma.stationLogonSession.findMany({
      where,
      select,
      orderBy,
      ...(Number(input.limit) > 0 ? { take: Number(input.limit) } : {}),
      skip: Number(input.offset),
    }),
    prisma.stationLogonSession.count({ where }),
  ]);

  const rows = data.map((row) => {
    const employeeName = row.employee?.version
      ? `${row.employee.version.firstName} ${row.employee.version.lastName}`.trim()
      : null;
    const durationSeconds = row.logoffTime
      ? Math.round((row.logoffTime.getTime() - row.logonTime.getTime()) / 1000)
      : null;
    return {
      id: row.id,
      logonTime: row.logonTime,
      logoffTime: row.logoffTime,
      durationSeconds,
      logonMethod: row.logonMethod,
      stationId: row.stationId,
      stationName: row.station.name,
      displayName: row.display?.name ?? null,
      employeeName: employeeName ?? row.genericName ?? null,
      employeeNumber: row.employee?.version?.employeeNumber ?? null,
      shiftName: row.shiftInstance?.shiftName ?? null,
      businessDate: row.shiftInstance?.businessDate ?? null,
    };
  });

  return { data: rows, total };
});

// ============================================================================
// Part Log search (aggregated, paginated)
//
// Per Date × Shift × Machine × Part: totalProduction (from InventoryItem count),
// totalDefect (sum of ItemDispositionLog.quantity), totalGood (production − defect).
// Mirrors the aggregation conventions used by badItems in metric-bucket compute:
// every non-deleted disposition row contributes to defect regardless of kind.
// ============================================================================

const PART_LOG_QUERYABLE_FIELDS: FieldAllowlist = {
  businessDate: { column: "businessDate", type: "string" },
  shiftName: { column: "shiftName", type: "string" },
  stationName: { column: "stationName", type: "string" },
  partName: { column: "partName", type: "string" },
  partSku: { column: "partSku", type: "string" },
  totalProduction: { column: "totalProduction", type: "number" },
  totalDefect: { column: "totalDefect", type: "number" },
  totalGood: { column: "totalGood", type: "number" },
};

const partLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const partLogSearch = authRequired.input(partLogSearchInputSchema).handler(async ({ input }) => {
  // Resolve station scope + workcenter map for shift lookup
  let stationIds: string[];
  let stationWorkcenterMap: Map<string, string | null>;
  const stationNameMap = new Map<string, string>();

  if (input.stationId) {
    const st = await prisma.station.findUnique({
      where: { id: input.stationId },
      select: { id: true, name: true, workcenterId: true },
    });
    stationIds = st ? [st.id] : [];
    stationWorkcenterMap = new Map(st ? [[st.id, st.workcenterId]] : []);
    if (st) stationNameMap.set(st.id, st.name);
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true, name: true, workcenterId: true },
    });
    stationIds = stations.map((s) => s.id);
    stationWorkcenterMap = new Map(stations.map((s) => [s.id, s.workcenterId]));
    for (const s of stations) stationNameMap.set(s.id, s.name);
  } else {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId },
      select: { id: true, name: true, workcenterId: true },
    });
    stationIds = stations.map((s) => s.id);
    stationWorkcenterMap = new Map(stations.map((s) => [s.id, s.workcenterId]));
    for (const s of stations) stationNameMap.set(s.id, s.name);
  }

  if (stationIds.length === 0) {
    return { data: [], total: 0 };
  }

  // Time range
  const rangeStart = input.startDate ? new Date(input.startDate) : new Date("2000-01-01");
  const rangeEnd = input.endDate
    ? (() => {
        const d = new Date(input.endDate);
        d.setDate(d.getDate() + 1);
        return d;
      })()
    : new Date("2100-01-01");

  // Shift instances overlapping the range (for InventoryItem attribution)
  const siWhere: Record<string, unknown> = {
    startTime: { lt: rangeEnd },
    endTime: { gt: rangeStart },
  };
  if (input.workCenterId) {
    siWhere.OR = [{ siteId: input.siteId, workCenterId: null }, { workCenterId: input.workCenterId }];
  } else {
    siWhere.siteId = input.siteId;
  }

  const shiftInstances = await prisma.shiftInstance.findMany({
    where: siWhere,
    select: {
      shiftName: true,
      businessDate: true,
      startTime: true,
      endTime: true,
      workCenterId: true,
    },
    orderBy: { startTime: "asc" },
  });

  const shiftsByWc = new Map<string | null, typeof shiftInstances>();
  for (const si of shiftInstances) {
    const key = si.workCenterId;
    if (!shiftsByWc.has(key)) shiftsByWc.set(key, []);
    shiftsByWc.get(key)?.push(si);
  }

  function findShift(timestamp: Date, stationId: string) {
    const wcId = stationWorkcenterMap.get(stationId) ?? null;
    const shifts = shiftsByWc.get(wcId) ?? shiftsByWc.get(null) ?? [];
    for (const si of shifts) {
      if (timestamp >= si.startTime && timestamp < si.endTime) {
        return si;
      }
    }
    return null;
  }

  interface Agg {
    businessDate: string | null;
    shiftName: string | null;
    stationId: string;
    stationName: string;
    partName: string;
    partSku: string | null;
    totalProduction: number;
    totalDefect: number;
    totalGood: number;
  }

  const aggMap = new Map<string, Agg>();
  // Group by the product PARENT id, not the snapshotted name: re-versions
  // must not split rows and two products sharing a name must not merge.
  // Legacy rows without a stamped productId key on the snapshot name.
  const keyOf = (businessDate: string | null, shiftName: string | null, stationId: string, productKey: string) =>
    `${businessDate ?? "*"}::${shiftName ?? "*"}::${stationId}::${productKey}`;

  // Pass 1 — Items (production)
  const items = await prisma.inventoryItem.findMany({
    where: {
      deletedAt: null,
      cycle: {
        siteId: input.siteId,
        deletedAt: null,
        end: { gte: rangeStart, lt: rangeEnd },
        stationId: stationIds.length === 1 ? stationIds[0] : { in: stationIds },
      },
    },
    select: {
      productId: true,
      cycle: {
        select: {
          end: true,
          start: true,
          stationId: true,
          businessDate: true,
          shiftInstance: { select: { shiftName: true, businessDate: true } },
        },
      },
      productVersion: { select: { name: true, sku: true } },
      product: { select: { currentVersion: { select: { name: true, sku: true } } } },
    },
  });

  for (const item of items) {
    const stationId = item.cycle.stationId;
    const ts = item.cycle.end ?? item.cycle.start;
    // Prefer the cycle's stamped context; overlap lookup only for legacy rows.
    let businessDate: string | null;
    let shiftName: string | null;
    if (item.cycle.shiftInstance) {
      businessDate = (item.cycle.businessDate ?? item.cycle.shiftInstance.businessDate).toISOString().slice(0, 10);
      shiftName = item.cycle.shiftInstance.shiftName ?? null;
    } else {
      const shift = findShift(ts, stationId);
      businessDate = shift?.businessDate
        ? shift.businessDate.toISOString().slice(0, 10)
        : ts.toISOString().slice(0, 10);
      shiftName = shift?.shiftName ?? null;
    }
    // Label from the current version (stable across re-versions); snapshot
    // name only for legacy rows with no stamped parent.
    const partName = item.product?.currentVersion?.name ?? item.productVersion?.name ?? "\u2014";
    const partSku = item.product?.currentVersion?.sku ?? item.productVersion?.sku ?? null;
    const stationName = stationNameMap.get(stationId) ?? "";

    const key = keyOf(businessDate, shiftName, stationId, item.productId ?? partName);
    let entry = aggMap.get(key);
    if (!entry) {
      entry = {
        businessDate,
        shiftName,
        stationId,
        stationName,
        partName,
        partSku,
        totalProduction: 0,
        totalDefect: 0,
        totalGood: 0,
      };
      aggMap.set(key, entry);
    }
    entry.totalProduction += 1;
    if (entry.partSku == null && partSku != null) entry.partSku = partSku;
  }

  // Pass 2 — Dispositions (defect). ItemDispositionLog already has shiftInstance
  // joined, so we use it directly rather than re-attributing via findShift.
  const dispositions = await prisma.itemDispositionLog.findMany({
    where: {
      siteId: input.siteId,
      deletedAt: null,
      // Event time (occurredAt) wins; createdAt only for pre-backfill rows.
      OR: [
        { occurredAt: { gte: rangeStart, lt: rangeEnd } },
        { occurredAt: null, createdAt: { gte: rangeStart, lt: rangeEnd } },
      ],
      stationId: stationIds.length === 1 ? stationIds[0] : { in: stationIds },
    },
    select: {
      stationId: true,
      createdAt: true,
      occurredAt: true,
      businessDate: true,
      productId: true,
      quantity: true,
      productVersion: { select: { name: true, sku: true } },
      product: { select: { currentVersion: { select: { name: true, sku: true } } } },
      shiftInstance: { select: { shiftName: true, businessDate: true } },
    },
  });

  for (const d of dispositions) {
    const stationId = d.stationId;
    const at = d.occurredAt ?? d.createdAt;
    // Stamped businessDate wins; shiftInstance join, then overlap lookup.
    let businessDate: string | null;
    let shiftName: string | null;
    if (d.shiftInstance) {
      businessDate = (d.businessDate ?? d.shiftInstance.businessDate).toISOString().slice(0, 10);
      shiftName = d.shiftInstance.shiftName ?? null;
    } else {
      const shift = findShift(at, stationId);
      businessDate = d.businessDate
        ? d.businessDate.toISOString().slice(0, 10)
        : shift?.businessDate
          ? shift.businessDate.toISOString().slice(0, 10)
          : at.toISOString().slice(0, 10);
      shiftName = shift?.shiftName ?? null;
    }
    const partName = d.product?.currentVersion?.name ?? d.productVersion?.name ?? "\u2014";
    const partSku = d.product?.currentVersion?.sku ?? d.productVersion?.sku ?? null;
    const stationName = stationNameMap.get(stationId) ?? "";

    const key = keyOf(businessDate, shiftName, stationId, d.productId ?? partName);
    let entry = aggMap.get(key);
    if (!entry) {
      entry = {
        businessDate,
        shiftName,
        stationId,
        stationName,
        partName,
        partSku,
        totalProduction: 0,
        totalDefect: 0,
        totalGood: 0,
      };
      aggMap.set(key, entry);
    }
    entry.totalDefect += d.quantity;
    if (entry.partSku == null && partSku != null) entry.partSku = partSku;
  }

  // Finalize totalGood = production − defect (clamped)
  let rows = Array.from(aggMap.values()).map((r) => ({
    ...r,
    totalGood: Math.max(0, r.totalProduction - r.totalDefect),
  }));

  // Dynamic query builder filters (in-memory)
  if (input.query) {
    const predicate = toRowFilter(input.query, PART_LOG_QUERYABLE_FIELDS);
    rows = rows.filter(predicate);
  }

  // Sort
  type Row = (typeof rows)[number];
  const SORTABLE: Record<string, (r: Row) => string | number> = {
    businessDate: (r) => r.businessDate ?? "",
    shiftName: (r) => r.shiftName ?? "",
    stationName: (r) => r.stationName,
    partName: (r) => r.partName,
    partSku: (r) => r.partSku ?? "",
    totalProduction: (r) => r.totalProduction,
    totalDefect: (r) => r.totalDefect,
    totalGood: (r) => r.totalGood,
  };

  const sortKey = input.sortBy && SORTABLE[input.sortBy] ? SORTABLE[input.sortBy] : SORTABLE.businessDate;
  const sortMul = input.sortDir === "asc" ? 1 : -1;

  rows.sort((a, b) => {
    const va = sortKey(a);
    const vb = sortKey(b);
    if (va < vb) return -1 * sortMul;
    if (va > vb) return 1 * sortMul;
    return 0;
  });

  // Paginate
  const total = rows.length;
  const offset = Number(input.offset);
  const limit = Number(input.limit);
  const page = limit > 0 ? rows.slice(offset, offset + limit) : rows;

  return { data: page, total };
});
