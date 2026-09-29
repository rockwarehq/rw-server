import { z } from "zod";
import { userRequired, userOrDisplayRequired } from "./middleware.js";
import prisma from "@rw/db";
import * as shiftCommentService from "@rw/services/facility/shift/shift-comment";
import * as shiftRecapService from "@rw/services/facility/shift/shift-recap";
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
    return shiftRecapService.metricBuckets(input);
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
    return shiftRecapService.stationJobLogs(input);
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
  return shiftRecapService.jobMetrics(input);
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
    return shiftRecapService.downtimeLogs(input);
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
    return shiftRecapService.scrapByReason(input);
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
