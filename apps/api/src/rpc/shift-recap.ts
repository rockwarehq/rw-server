import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import * as shiftCommentService from "@rw/services/facility/shift/shift-comment";
import { throwServiceError } from "./errors.js";
import {
  hourUnionSourceSql,
  jobDedupSql,
  kpiSumsSql,
  latestNonNullSql,
  ratioSumsSql,
  syntheticBucketId,
  JOB_HOUR_PREDICATE,
  STATION_HOUR_PREDICATE,
} from "./metric-hour-sql.js";

// ============================================================================
// Shift Instance List (by site + business date + optional workcenter)
// ============================================================================

const shiftInstanceListInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
});

const shiftInstanceSelect = {
  id: true,
  shiftName: true,
  businessDate: true,
  startTime: true,
  endTime: true,
  workCenterId: true,
} as const;

export const shiftInstanceList = authRequired.input(shiftInstanceListInputSchema).handler(async ({ input }) => {
  const rows = await prisma.shiftInstance.findMany({
    where: {
      siteId: input.siteId,
      workCenterId: input.workCenterId,
      businessDate: new Date(input.businessDate),
    },
    orderBy: { startTime: "asc" },
    select: shiftInstanceSelect,
  });
  return rows;
});

// ============================================================================
// Current Shift Instance (shift containing the current UTC time)
// ============================================================================

const currentShiftInstanceInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid(),
});

export const currentShiftInstance = userOrDisplayRequired
  .input(currentShiftInstanceInputSchema)
  .handler(async ({ input }) => {
    const now = new Date();
    const row = await prisma.shiftInstance.findFirst({
      where: {
        siteId: input.siteId,
        workCenterId: input.workCenterId,
        startTime: { lte: now },
        endTime: { gte: now },
      },
      orderBy: { startTime: "desc" },
      select: shiftInstanceSelect,
    });
    return row;
  });

// ============================================================================
// Metric Bucket Log query (by shift instance + entity filters)
// ============================================================================

const metricBucketLogListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const metricBucketLogList = authRequired.input(metricBucketLogListInputSchema).handler(async ({ input }) => {
  // Stage B: shift rows are aggregated from the stations' HOUR buckets
  // (live ∪ archived) — one row per station plus one synthesized workcenter
  // total row, instead of reading the SHIFT/WORKCENTER tiers.
  const [stations, shiftInstance, workcenter] = await Promise.all([
    prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true, name: true },
    }),
    prisma.shiftInstance.findUnique({
      where: { id: input.shiftInstanceId },
      select: { shiftName: true, startTime: true, endTime: true },
    }),
    prisma.workcenter.findUnique({
      where: { id: input.workCenterId },
      select: { name: true },
    }),
  ]);

  const stationIds = stations.map((s) => s.id);
  if (stationIds.length === 0) return [];
  const stationNameById = new Map(stations.map((s) => [s.id, s.name]));

  const predicate = Prisma.sql`mb."siteId" = ${input.siteId}::uuid
    AND mb."shiftInstanceId" = ${input.shiftInstanceId}::uuid
    AND ${STATION_HOUR_PREDICATE}
    AND mb."entityId" = ANY(${stationIds}::uuid[])`;

  type AggRow = {
    entityId: string | null; // NULL on the grand-total (workcenter) row
    minStartTime: Date;
    sumDurationSeconds: number;
    businessDate: Date | null;
    businessShift: string | null;
    currentJobName: string | null;
    totalCycles: number;
    goodCycles: number;
    badCycles: number;
    totalItems: number;
    goodItems: number;
    badItems: number;
    runSeconds: number;
    downSeconds: number;
    plannedDownSeconds: number;
    unplannedDownSeconds: number;
    expectedCycles: number;
    expectedItems: number;
    idealCycleSeconds: number;
    totalCycleSeconds: number;
    elapsedPlannedProductionSeconds: number;
    availability: Prisma.Decimal | null;
    performance: Prisma.Decimal | null;
    quality: Prisma.Decimal | null;
    oee: Prisma.Decimal | null;
  };

  // GROUPING SETS: per-station groups plus one grand-total row for the
  // synthesized workcenter aggregate, from a single scan.
  const rows = await prisma.$queryRaw<AggRow[]>`
    WITH src AS (${hourUnionSourceSql(predicate)})
    SELECT
      s."entityId" AS "entityId",
      MIN(s."startTime") AS "minStartTime",
      SUM(s."durationSeconds")::int AS "sumDurationSeconds",
      MAX(s."businessDate") AS "businessDate",
      MAX(s."businessShift") AS "businessShift",
      ${latestNonNullSql(Prisma.sql`s."currentJobName"`, Prisma.sql`s."startTime" DESC, s."updatedAt" DESC`)} AS "currentJobName",
      ${kpiSumsSql("s")},
      ${ratioSumsSql("s")}
    FROM src s
    GROUP BY GROUPING SETS ((s."entityId"), ())
    HAVING COUNT(*) > 0
  `;

  const shiftStart = shiftInstance?.startTime ?? null;
  const shiftDurationSeconds = shiftInstance
    ? Math.round((shiftInstance.endTime.getTime() - shiftInstance.startTime.getTime()) / 1000)
    : null;
  const granularityName = shiftInstance?.shiftName ?? "Shift";

  const toRow = (
    r: AggRow,
    entity: { entityType: "STATION" | "WORKCENTER"; entityId: string; entityName: string },
    currentJobName: string | null,
  ) => ({
    id: syntheticBucketId(entity.entityType, entity.entityId, null, "SHIFT", shiftStart ?? r.minStartTime),
    entityType: entity.entityType,
    entityId: entity.entityId,
    entityName: entity.entityName,
    granularity: "SHIFT" as const,
    granularityName,
    startTime: shiftStart ?? r.minStartTime,
    durationSeconds: shiftDurationSeconds ?? r.sumDurationSeconds,
    shiftInstanceId: input.shiftInstanceId,
    businessDate: r.businessDate,
    businessShift: r.businessShift,
    currentJobName,
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
    idealCycleSeconds: r.idealCycleSeconds,
    totalCycleSeconds: r.totalCycleSeconds,
    elapsedPlannedProductionSeconds: r.elapsedPlannedProductionSeconds,
    availability: r.availability,
    performance: r.performance,
    quality: r.quality,
    oee: r.oee,
  });

  const stationRows = rows
    .filter((r): r is AggRow & { entityId: string } => r.entityId !== null)
    .map((r) =>
      toRow(
        r,
        { entityType: "STATION", entityId: r.entityId, entityName: stationNameById.get(r.entityId) ?? "" },
        r.currentJobName,
      ),
    )
    .sort((a, b) => a.entityName.localeCompare(b.entityName));

  const totalRow = rows.find((r) => r.entityId === null);
  const workcenterRows = totalRow
    ? [
        // currentJobName is null on the workcenter row — parity with the old
        // WORKCENTER rollups, which never carried job context.
        toRow(
          totalRow,
          { entityType: "WORKCENTER", entityId: input.workCenterId, entityName: workcenter?.name ?? "" },
          null,
        ),
      ]
    : [];

  // Old ordering was entityType asc (enum order: STATION before WORKCENTER),
  // then entityName asc.
  return [...stationRows, ...workcenterRows];
});

// ============================================================================
// Station Job Log query (jobs that ran on stations during a shift)
// ============================================================================

const stationJobLogListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const stationJobLogList = authRequired.input(stationJobLogListInputSchema).handler(async ({ input }) => {
  // Look up the shift instance for its time boundaries
  const shiftInstance = await prisma.shiftInstance.findUniqueOrThrow({
    where: { id: input.shiftInstanceId },
    select: { startTime: true, endTime: true },
  });

  // Get stations belonging to this workcenter
  const stations = await prisma.station.findMany({
    where: { siteId: input.siteId, workcenterId: input.workCenterId },
    select: { id: true },
  });

  const stationIds = stations.map((s) => s.id);

  // Query StationJobLog for any jobs overlapping the shift window
  const rows = await prisma.stationJobLog.findMany({
    where: {
      stationId: { in: stationIds },
      startTime: { lt: shiftInstance.endTime },
      OR: [{ endTime: { gt: shiftInstance.startTime } }, { endTime: null }],
    },
    orderBy: [{ stationId: "asc" }, { startTime: "asc" }],
    select: {
      id: true,
      stationId: true,
      startTime: true,
      endTime: true,
      standardCycle: true,
      job: { select: { currentVersion: { select: { name: true } } } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    stationId: r.stationId,
    startTime: r.startTime < shiftInstance.startTime ? shiftInstance.startTime : r.startTime,
    endTime: r.endTime == null || r.endTime > shiftInstance.endTime ? shiftInstance.endTime : r.endTime,
    standardCycle: r.standardCycle ? Number(r.standardCycle) : null,
    jobName: r.job.currentVersion?.name ?? null,
  }));
});

// ============================================================================
// Job metrics query (JOB-entity MetricBucketLog for a shift)
// ============================================================================

const jobMetricsListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const jobMetricsList = authRequired.input(jobMetricsListInputSchema).handler(async ({ input }) => {
  // Get stations in workcenter — job buckets are per-station (entityId holds
  // the station id, jobId the job id), so scoping is a plain entityId filter.
  const stations = await prisma.station.findMany({
    where: { siteId: input.siteId, workcenterId: input.workCenterId },
    select: { id: true },
  });

  const stationIds = stations.map((s) => s.id);
  if (stationIds.length === 0) return [];

  // Stage B: aggregate job-scope HOUR rows (live ∪ archived) per
  // (station, job) for the shift instead of reading the JOB SHIFT tier.
  const predicate = Prisma.sql`mb."siteId" = ${input.siteId}::uuid
    AND mb."shiftInstanceId" = ${input.shiftInstanceId}::uuid
    AND ${JOB_HOUR_PREDICATE}
    AND mb."entityId" = ANY(${stationIds}::uuid[])`;

  type JobAggRow = {
    stationId: string;
    jobId: string;
    jobName: string | null;
    minStartTime: Date;
    standardCycle: number | null;
    totalCycles: number;
    goodCycles: number;
    badCycles: number;
    totalItems: number;
    goodItems: number;
    badItems: number;
    totalCycleSeconds: number;
    idealCycleSeconds: number;
    runSeconds: number;
    downSeconds: number;
    plannedDownSeconds: number;
    unplannedDownSeconds: number;
    expectedItems: number;
    elapsedPlannedProductionSeconds: number;
    availability: Prisma.Decimal | null;
    performance: Prisma.Decimal | null;
    quality: Prisma.Decimal | null;
    oee: Prisma.Decimal | null;
  };

  const rows = await prisma.$queryRaw<JobAggRow[]>`
    WITH src AS (${jobDedupSql(hourUnionSourceSql(predicate))})
    SELECT
      s."entityId" AS "stationId",
      s."jobId" AS "jobId",
      COALESCE(jv."name", MAX(s."currentJobName")) AS "jobName",
      MIN(s."startTime") AS "minStartTime",
      (${latestNonNullSql(Prisma.sql`s."currentStandardCycle"`, Prisma.sql`s."startTime" DESC, s."updatedAt" DESC`)})::float8 AS "standardCycle",
      ${kpiSumsSql("s")},
      ${ratioSumsSql("s")}
    FROM src s
    LEFT JOIN "Job" j ON j.id = s."jobId"
    LEFT JOIN "JobVersion" jv ON jv.id = j."currentVersionId"
    GROUP BY s."entityId", s."jobId", jv."name"
    ORDER BY "jobName" ASC, s."entityId" ASC
  `;

  return rows.map((r) => ({
    id: syntheticBucketId("JOB", r.stationId, r.jobId, "SHIFT", r.minStartTime),
    jobId: r.jobId,
    jobName: r.jobName ?? "",
    stationId: r.stationId,
    totalCycles: r.totalCycles,
    goodCycles: r.goodCycles,
    badCycles: r.badCycles,
    totalItems: r.totalItems,
    goodItems: r.goodItems,
    badItems: r.badItems,
    totalCycleSeconds: r.totalCycleSeconds,
    idealCycleSeconds: r.idealCycleSeconds,
    elapsedPlannedProductionSeconds: r.elapsedPlannedProductionSeconds,
    standardCycle: r.standardCycle,
    avgCycleTimeSeconds: r.totalCycles > 0 ? r.totalCycleSeconds / r.totalCycles : null,
    runSeconds: r.runSeconds,
    downSeconds: r.downSeconds,
    plannedDownSeconds: r.plannedDownSeconds,
    unplannedDownSeconds: r.unplannedDownSeconds,
    expectedItems: r.expectedItems,
    availability: r.availability,
    performance: r.performance,
    quality: r.quality,
    oee: r.oee,
  }));
});

// ============================================================================
// Downtime log query (DOWN state logs overlapping a shift)
// ============================================================================

const downtimeLogListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  stationId: z.uuid().optional(),
  workCenterId: z.uuid().optional(),
});

export const downtimeLogList = userOrDisplayRequired.input(downtimeLogListInputSchema).handler(async ({ input }) => {
  const shiftInstance = await prisma.shiftInstance.findUniqueOrThrow({
    where: { id: input.shiftInstanceId },
    select: { startTime: true, endTime: true },
  });

  // Resolve station IDs — single station or all in workcenter
  let stationFilter: string | { in: string[] };
  if (input.stationId) {
    stationFilter = input.stationId;
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    stationFilter = { in: stations.map((s) => s.id) };
  } else {
    return [];
  }

  const rows = await prisma.stationStateLog.findMany({
    where: {
      stationId: stationFilter,
      state: "DOWN",
      deletedAt: null,
      startTime: { lt: shiftInstance.endTime },
      OR: [{ endTime: { gt: shiftInstance.startTime } }, { endTime: null }],
    },
    orderBy: { startTime: "asc" },
    select: {
      id: true,
      stationId: true,
      startTime: true,
      endTime: true,
      statusReasonId: true,
      statusReason: { select: { id: true, name: true } },
    },
  });

  return rows.map((r) => {
    const clamped = r.startTime < shiftInstance.startTime || r.endTime == null || r.endTime > shiftInstance.endTime;
    return {
      id: r.id,
      stationId: r.stationId,
      startTime: r.startTime < shiftInstance.startTime ? shiftInstance.startTime : r.startTime,
      endTime: r.endTime == null || r.endTime > shiftInstance.endTime ? shiftInstance.endTime : r.endTime,
      // Include raw times when they differ from the shift-clamped values
      rawStartTime: clamped ? r.startTime : null,
      rawEndTime: clamped ? (r.endTime ?? null) : null,
      statusReasonId: r.statusReasonId,
      statusReasonName: r.statusReason?.name ?? null,
    };
  });
});

// ============================================================================
// Scrap / Disposition totals by reason (per station, for a shift)
// ============================================================================

const scrapByReasonListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const scrapByReasonList = userOrDisplayRequired
  .input(scrapByReasonListInputSchema)
  .handler(async ({ input }) => {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    const stationIds = stations.map((s) => s.id);
    if (stationIds.length === 0) return [];

    const groups = await prisma.itemDispositionLog.groupBy({
      by: ["stationId", "dispositionReasonId"],
      where: {
        siteId: input.siteId,
        shiftInstanceId: input.shiftInstanceId,
        stationId: { in: stationIds },
        deletedAt: null,
      },
      _sum: { quantity: true },
      _count: { _all: true },
    });

    const reasonIds = groups.map((g) => g.dispositionReasonId).filter((id): id is string => id != null);
    const reasons = reasonIds.length
      ? await prisma.itemDispositionReason.findMany({
          where: { id: { in: reasonIds } },
          select: { id: true, name: true },
        })
      : [];
    const reasonNameById = new Map(reasons.map((r) => [r.id, r.name]));

    return groups.map((g) => ({
      stationId: g.stationId,
      dispositionReasonId: g.dispositionReasonId,
      dispositionReasonName: g.dispositionReasonId ? (reasonNameById.get(g.dispositionReasonId) ?? null) : null,
      totalQuantity: g._sum.quantity ?? 0,
      entryCount: g._count._all,
    }));
  });

// ============================================================================
// Shift Comments (workcenter-overall + per-station, append-only thread)
// ============================================================================

const commentListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const commentList = userOrDisplayRequired.input(commentListInputSchema).handler(async ({ input }) => {
  const result = await shiftCommentService.list({
    shiftInstanceId: input.shiftInstanceId,
    workcenterId: input.workCenterId,
  });
  return result.data;
});

const commentCreateInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
  stationId: z.uuid().nullable().optional(),
  text: z.string().min(1).max(5000),
});

export const commentCreate = authRequired.input(commentCreateInputSchema).handler(async ({ input, context }) => {
  const result = await shiftCommentService.create({
    siteId: input.siteId,
    shiftInstanceId: input.shiftInstanceId,
    workcenterId: input.workCenterId,
    stationId: input.stationId ?? null,
    text: input.text,
    createdById: context.iam.id,
  });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

const commentUpdateInputSchema = z.object({
  id: z.uuid(),
  text: z.string().min(1).max(5000),
});

export const commentUpdate = authRequired.input(commentUpdateInputSchema).handler(async ({ input, context }) => {
  const result = await shiftCommentService.update(input.id, {
    text: input.text,
    actorId: context.iam.id,
  });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

const commentDeleteInputSchema = z.object({
  id: z.uuid(),
});

export const commentDelete = authRequired.input(commentDeleteInputSchema).handler(async ({ input, context }) => {
  const result = await shiftCommentService.remove(input.id, { actorId: context.iam.id });
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});
