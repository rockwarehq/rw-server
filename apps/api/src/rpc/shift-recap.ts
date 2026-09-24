import { z } from "zod";
import { userRequired, userOrDisplayRequired } from "./middleware.js";
import prisma from "@rw/db";
import * as shiftCommentService from "@rw/services/facility/shift/shift-comment";
import * as shiftSignoffService from "@rw/services/facility/shift/shift-signoff";
import { throwServiceError } from "./errors.js";

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
  isScheduled: true,
} as const;

export const shiftInstanceList = userRequired
  .input(shiftInstanceListInputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { site: input.siteId });

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
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { site: input.siteId });

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

export const metricBucketLogList = userRequired
  .input(metricBucketLogListInputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { workcenter: input.workCenterId });

    // Get stations belonging to this workcenter
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true, name: true },
    });

    const stationIds = stations.map((s) => s.id);

    const where = {
      siteId: input.siteId,
      shiftInstanceId: input.shiftInstanceId,
      granularity: "SHIFT" as const,
      OR: [
        { entityType: "WORKCENTER" as const, entityId: input.workCenterId },
        { entityType: "STATION" as const, entityId: { in: stationIds } },
      ],
    };

    const select = {
      id: true,
      entityType: true,
      entityId: true,
      entityName: true,
      granularity: true,
      granularityName: true,
      startTime: true,
      durationSeconds: true,
      shiftInstanceId: true,
      businessDate: true,
      businessShift: true,
      currentJobName: true,
      totalCycles: true,
      goodCycles: true,
      badCycles: true,
      totalItems: true,
      goodItems: true,
      badItems: true,
      runSeconds: true,
      downSeconds: true,
      plannedDownSeconds: true,
      unplannedDownSeconds: true,
      expectedCycles: true,
      expectedItems: true,
      idealCycleSeconds: true,
      totalCycleSeconds: true,
      elapsedPlannedProductionSeconds: true,
      availability: true,
      performance: true,
      quality: true,
      oee: true,
    } as const;

    const orderBy = [{ entityType: "asc" as const }, { entityName: "asc" as const }];

    // Read live first so an archive move between reads cannot hide a bucket.
    // Partial archives still need live stations; archived copies win by id.
    const live = await prisma.metricBucket.findMany({ where, orderBy, select });
    const archived = await prisma.metricBucketLog.findMany({ where, orderBy, select });
    const rows = new Map(live.map((row) => [row.id, row]));
    for (const row of archived) rows.set(row.id, row);
    return [...rows.values()].sort(
      (a, b) => a.entityType.localeCompare(b.entityType) || a.entityName.localeCompare(b.entityName),
    );
  });

// ============================================================================
// Station Job Log query (jobs that ran on stations during a shift)
// ============================================================================

const stationJobLogListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const stationJobLogList = userRequired
  .input(stationJobLogListInputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { workcenter: input.workCenterId });

    // Look up the shift instance for its time boundaries
    const shiftInstance = await prisma.shiftInstance.findFirstOrThrow({
      where: { id: input.shiftInstanceId, siteId: input.siteId },
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
        jobId: true,
        blockId: true,
        amendmentId: true,
        startTime: true,
        endTime: true,
        standardCycle: true,
        job: { select: { currentVersion: { select: { name: true } } } },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      stationId: r.stationId,
      jobId: r.jobId,
      blockId: r.blockId,
      amendmentId: r.amendmentId,
      isOpen: r.endTime == null,
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

export const jobMetricsList = userRequired.input(jobMetricsListInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { workcenter: input.workCenterId });

  // Get stations in workcenter to build path filter
  const stations = await prisma.station.findMany({
    where: { siteId: input.siteId, workcenterId: input.workCenterId },
    select: { id: true },
  });

  const stationIds = stations.map((s) => s.id);

  // Query JOB-entity metric rows for this shift.
  // Path format: "site.{siteId}...station.{stationId}.job.{jobId}"
  // Filter to jobs under stations in this workcenter via path contains.
  const where = {
    siteId: input.siteId,
    shiftInstanceId: input.shiftInstanceId,
    entityType: "JOB" as const,
    granularity: "SHIFT" as const,
    OR: stationIds.map((sid) => ({
      path: { contains: `.station.${sid}.` },
    })),
  };

  const select = {
    id: true,
    entityId: true,
    entityName: true,
    path: true,
    totalCycles: true,
    goodCycles: true,
    badCycles: true,
    totalItems: true,
    goodItems: true,
    badItems: true,
    totalCycleSeconds: true,
    idealCycleSeconds: true,
    currentStandardCycle: true,
    runSeconds: true,
    downSeconds: true,
    plannedDownSeconds: true,
    unplannedDownSeconds: true,
    expectedItems: true,
    elapsedPlannedProductionSeconds: true,
    availability: true,
    performance: true,
    quality: true,
    oee: true,
  } as const;

  const orderBy = [{ entityName: "asc" as const }];

  // Try archived data first; fall back to live MetricBucket for current shifts
  let rows = await prisma.metricBucketLog.findMany({ where, orderBy, select });
  if (rows.length === 0) {
    rows = await prisma.metricBucket.findMany({ where, orderBy, select });
  }

  // Extract stationId from path and compute avg cycle time
  return rows.map((r) => {
    const stationMatch = r.path.match(/\.station\.([^.]+)\./);
    const avgCycleTimeSeconds = r.totalCycles > 0 ? Number(r.totalCycleSeconds) / r.totalCycles : null;

    return {
      id: r.id,
      jobId: r.entityId,
      jobName: r.entityName,
      stationId: stationMatch?.[1] ?? null,
      totalCycles: r.totalCycles,
      goodCycles: r.goodCycles,
      badCycles: r.badCycles,
      totalItems: r.totalItems,
      goodItems: r.goodItems,
      badItems: r.badItems,
      totalCycleSeconds: r.totalCycleSeconds,
      idealCycleSeconds: r.idealCycleSeconds,
      elapsedPlannedProductionSeconds: r.elapsedPlannedProductionSeconds,
      standardCycle: r.currentStandardCycle ? Number(r.currentStandardCycle) : null,
      avgCycleTimeSeconds,
      runSeconds: r.runSeconds,
      downSeconds: r.downSeconds,
      plannedDownSeconds: r.plannedDownSeconds,
      unplannedDownSeconds: r.unplannedDownSeconds,
      expectedItems: r.expectedItems,
      availability: r.availability,
      performance: r.performance,
      quality: r.quality,
      oee: r.oee,
    };
  });
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

export const downtimeLogList = userOrDisplayRequired
  .input(downtimeLogListInputSchema)
  .handler(async ({ input, context }) => {
    // Shift recaps are workcenter data: check the station or workcenter asked for.
    if (input.stationId) await context.access.require("VIEW", { station: input.stationId });
    else if (input.workCenterId) await context.access.require("VIEW", { workcenter: input.workCenterId });
    else await context.access.require("VIEW", { site: input.siteId });

    const shiftInstance = await prisma.shiftInstance.findFirstOrThrow({
      where: { id: input.shiftInstanceId, siteId: input.siteId },
      select: { startTime: true, endTime: true },
    });

    // Resolve station IDs — single station or all in workcenter
    let stationFilter: string | { in: string[] };
    if (input.stationId) {
      const station = await prisma.station.findFirst({
        where: { id: input.stationId, siteId: input.siteId },
        select: { id: true },
      });
      if (!station) return [];
      stationFilter = station.id;
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
        isPlannedDown: true,
        statusReason: { select: { id: true, name: true, isPlannedDown: true } },
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
        isPlannedDown: r.isPlannedDown,
        reasonIsPlannedDown: r.statusReason?.isPlannedDown ?? null,
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
  // One station of the workcenter, for a station's own board.
  stationId: z.uuid().optional(),
});

export const scrapByReasonList = userOrDisplayRequired
  .input(scrapByReasonListInputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { workcenter: input.workCenterId });

    const stations = await prisma.station.findMany({
      where: {
        siteId: input.siteId,
        workcenterId: input.workCenterId,
        ...(input.stationId ? { id: input.stationId } : {}),
      },
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
// Scrap entries (one station, for a shift) — the counterpart of downtimeLogs,
// each entry with its time, so a station's board can put scrap in its hour
// ============================================================================

const scrapLogListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  stationId: z.uuid(),
});

export const scrapLogList = userOrDisplayRequired.input(scrapLogListInputSchema).handler(async ({ input, context }) => {
  // One station's floor data: check that station, as downtimeLogs does.
  await context.access.require("VIEW", { station: input.stationId });

  const rows = await prisma.itemDispositionLog.findMany({
    where: {
      siteId: input.siteId,
      stationId: input.stationId,
      shiftInstanceId: input.shiftInstanceId,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      createdAt: true,
      quantity: true,
      dispositionReasonId: true,
      dispositionReason: { select: { name: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    quantity: Number(r.quantity),
    dispositionReasonId: r.dispositionReasonId,
    dispositionReasonName: r.dispositionReason?.name ?? null,
  }));
});

// ============================================================================
// Shift Comments (workcenter-overall + per-station, append-only thread)
// Everything in a shift recap is workcenter data: checks name the workcenter.
// ============================================================================

const commentListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const commentList = userOrDisplayRequired.input(commentListInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { workcenter: input.workCenterId });

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
  /** Who is writing it. Required from an operator terminal, which has no user. */
  employeeId: z.uuid().optional(),
});

// Open to operator terminals, like calls: a display writes at its own site,
// and the operator names themselves since the display is no one.
export const commentCreate = userOrDisplayRequired
  .input(commentCreateInputSchema)
  .handler(async ({ input, context }) => {
    // Written on the workcenter's own site, whatever siteId was sent.
    const { siteId } = await context.access.require("MANAGE", { workcenter: input.workCenterId });

    const result = await shiftCommentService.create({
      siteId,
      shiftInstanceId: input.shiftInstanceId,
      workcenterId: input.workCenterId,
      stationId: input.stationId ?? null,
      text: input.text,
      createdById: context.current.kind === "user" ? context.current.user.id : null,
      createdByEmployeeId: input.employeeId,
    });
    if ("error" in result) throwServiceError(result);
    return result.data;
  });

const commentUpdateInputSchema = z.object({
  id: z.uuid(),
  text: z.string().min(1).max(5000),
});

export const commentUpdate = userRequired.input(commentUpdateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { shiftComment: input.id });

  const result = await shiftCommentService.update(input.id, {
    text: input.text,
    actorId: context.current.user.id,
  });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

const commentDeleteInputSchema = z.object({
  id: z.uuid(),
});

export const commentDelete = userRequired.input(commentDeleteInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { shiftComment: input.id });

  const result = await shiftCommentService.remove(input.id, { actorId: context.current.user.id });
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// Shift Recap Sign-off (supervisor "post" per shift instance + workcenter)
// ============================================================================

const signoffInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const signoffGet = userOrDisplayRequired.input(signoffInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { workcenter: input.workCenterId });

  const result = await shiftSignoffService.get({
    shiftInstanceId: input.shiftInstanceId,
    workcenterId: input.workCenterId,
  });
  return result.data;
});

export const signoffCreate = userRequired.input(signoffInputSchema).handler(async ({ input, context }) => {
  // Written on the workcenter's own site, whatever siteId was sent.
  const { siteId } = await context.access.require("MANAGE", { workcenter: input.workCenterId });

  const result = await shiftSignoffService.create({
    siteId,
    shiftInstanceId: input.shiftInstanceId,
    workcenterId: input.workCenterId,
    postedById: context.current.user.id,
  });
  if (result.error !== undefined) throwServiceError(result, { ALREADY_SIGNED_OFF: "CONFLICT" });
  return result.data;
});

export const signoffDelete = userRequired.input(signoffInputSchema).handler(async ({ input, context }) => {
  const { siteId } = await context.access.require("MANAGE", { workcenter: input.workCenterId });

  const result = await shiftSignoffService.remove({
    siteId,
    shiftInstanceId: input.shiftInstanceId,
    workcenterId: input.workCenterId,
    actorId: context.current.user.id,
  });
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});
