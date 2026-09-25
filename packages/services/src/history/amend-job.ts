import { canRunJob } from "../facility/station/eligibility.js";
import prisma from "@rw/db";
import type { JobHistoryAmendment } from "@rw/db";
import { restampCycles } from "../cycle/amend.js";
import { reassignItems } from "../inventory/amend.js";
import { restampCallsAndModes, restampStateLog } from "../facility/station/amend.js";
import { resolveEffectiveStandards } from "../facility/station/effective-standards.js";
import { applyTimelinePlan, loadTimelineRows, planTimelineRewrite } from "../facility/station/job-timeline.js";
import { type ChangeJobActor, publishJobChangeSideEffects } from "../facility/station/jobs.js";
import { acquireStationLock } from "../facility/station/state.js";
import { scheduleDetection } from "../facility/station/state-detection.js";
import { employeeName } from "../facility/work-context.js";
import type { AmendContext } from "./context.js";
import { publishJobHistoryEvent } from "./events.js";

// A retroactive job reassignment: "station S ran job J over [from, to)". The job
// log timeline and every module's facts are rewritten in one transaction under
// the station lock; buckets are rebuilt by the job-history event consumer.

// The station lock is held for the whole rewrite, so the window is bounded
// to keep live cycle completions (5s transaction budget) from timing out.
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AmendJobHistoryInput {
  stationId: string;
  jobId: string | null;
  from: Date;
  /** null = through now; also changes the station's current job. */
  to: Date | null;
  actor?: ChangeJobActor & { userId?: string };
}

export type AmendJobHistoryResult =
  | { data: { amendmentId: string; summary: Record<string, number>; currentJobChanged: boolean } }
  | {
      error: string;
      code:
        | "STATION_NOT_FOUND"
        | "JOB_NOT_FOUND"
        | "NO_CURRENT_VERSION"
        | "SITE_MISMATCH"
        | "LABEL_FILTER_MISMATCH"
        | "PROFILE_MISMATCH"
        | "INVALID_RANGE"
        | "RANGE_TOO_LARGE"
        | "JOB_REQUIRED"
        | "NO_CHANGE";
    };

export async function amendJobHistory(input: AmendJobHistoryInput): Promise<AmendJobHistoryResult> {
  const now = new Date();
  const { stationId, from, to } = input;
  const actor = input.actor ?? {};
  const toEff = to ?? now;
  if (!input.jobId) return { error: "An amendment must name a job", code: "JOB_REQUIRED" };
  if (from >= toEff || toEff > now) return { error: "Window must lie in the past", code: "INVALID_RANGE" };
  if (toEff.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return { error: "Window may span at most 24 hours", code: "RANGE_TOO_LARGE" };
  }

  const job = input.jobId
    ? await prisma.job.findUnique({
        where: { id: input.jobId },
        select: {
          id: true,
          siteId: true,
          deletedAt: true,
          currentVersionId: true,
          currentVersion: { select: { name: true } },
          versions: {
            where: { createdAt: { lte: from } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      })
    : null;
  if (input.jobId && (!job || job.deletedAt)) return { error: "Job not found", code: "JOB_NOT_FOUND" };
  const jobVersionId = job?.versions[0]?.id ?? job?.currentVersionId ?? null;
  if (job && !jobVersionId) return { error: "Job has no version", code: "NO_CURRENT_VERSION" };

  const result = await prisma.$transaction(
    async (tx) => {
      await acquireStationLock(tx, stationId);
      const station = await tx.station.findUnique({
        where: { id: stationId },
        select: {
          id: true,
          name: true,
          siteId: true,
          currentJobId: true,
          workcenterId: true,
          site: { select: { workspaceId: true } },
          workcenter: { select: { name: true } },
        },
      });
      if (!station) return { error: "Station not found" as const, code: "STATION_NOT_FOUND" as const };
      if (job && job.siteId !== station.siteId) {
        return { error: "Job and station must belong to the same site" as const, code: "SITE_MISMATCH" as const };
      }
      if (job) {
        const [reason] = await canRunJob(tx, stationId, job.id);
        if (reason) return { error: reason.message, code: reason.code };
      }

      const std = job && jobVersionId ? await resolveEffectiveStandards(tx, stationId, job.id, jobVersionId) : null;
      const rows = await loadTimelineRows(tx, stationId, from, to);
      const previous = rows.filter((r) => r.startTime < toEff && (r.endTime === null || r.endTime > from));
      const displacedJobIds = [...new Set(previous.map((r) => r.jobId))].filter((id) => id !== job?.id);
      const plan = planTimelineRewrite(rows, from, to, job && jobVersionId ? { jobId: job.id, jobVersionId } : null);
      if (plan.updates.length + plan.inserts.length + plan.deletes.length === 0) {
        return { error: "That job is already recorded for this window" as const, code: "NO_CHANGE" as const };
      }

      // Created first so the rewritten rows can reference it; the summary lands at the end.
      const created = await tx.jobHistoryAmendment.create({
        data: {
          siteId: station.siteId,
          stationId,
          jobId: job?.id ?? null,
          jobVersionId,
          fromTime: from,
          toTime: to,
          previousTimeline: JSON.parse(JSON.stringify(previous)),
          source: actor.source ?? "MANUAL",
          actorEmployeeId: actor.employeeId ?? null,
          actorUserId: actor.userId ?? null,
        },
      });
      const ctx: AmendContext = {
        tx,
        amendmentId: created.id,
        siteId: station.siteId,
        stationId,
        workcenterId: station.workcenterId,
        from,
        toEff,
        job:
          job && jobVersionId && std
            ? {
                id: job.id,
                versionId: jobVersionId,
                standardCycle: std.standardCycleSeconds,
                standardQuantity: std.standardQuantity,
                quantityUnit: std.quantityUnit,
              }
            : null,
      };

      await applyTimelinePlan(
        tx,
        station,
        plan,
        { from, toEff },
        {
          standardCycle: ctx.job?.standardCycle ?? null,
          standardQuantity: ctx.job?.standardQuantity ?? null,
          quantityUnit: ctx.job?.quantityUnit ?? "",
          amendmentId: created.id,
        },
      );

      const { cycleIds } = await restampCycles(ctx);
      const items = await reassignItems(ctx, cycleIds);
      const stateRows = await restampStateLog(ctx, to);
      const callsAndModes = await restampCallsAndModes(ctx);
      const summary = { cycles: cycleIds.length, ...items, stateRows, ...callsAndModes };

      if (!to) await tx.station.update({ where: { id: stationId }, data: { currentJobId: job?.id ?? null } });

      const amendment = await tx.jobHistoryAmendment.update({ where: { id: created.id }, data: { summary } });
      return { station, amendment, displacedJobIds, std, previousJobId: station.currentJobId };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  if ("error" in result) {
    // biome-ignore lint/style/noNonNullAssertion: `"error" in result` guarantees both, TS doesn't narrow the tx union
    return { error: result.error!, code: result.code! };
  }

  const { station, amendment, displacedJobIds, std, previousJobId } = result;
  await publishAmended(amendment, { ...station, displacedJobIds, jobName: job?.currentVersion?.name, actor });

  if (!to) {
    await publishJobChangeSideEffects({
      station,
      previousJobId,
      job,
      effectiveStandardCycle: std?.standardCycleSeconds ?? null,
      timestamp: now,
      actor,
    });
    if (job) {
      scheduleDetection(stationId, job.id).catch((err) => {
        console.error(`[amendJobHistory] scheduleDetection failed for station ${stationId}:`, err);
      });
    }
  }

  return {
    data: { amendmentId: amendment.id, summary: amendment.summary as Record<string, number>, currentJobChanged: !to },
  };
}

async function publishAmended(
  amendment: JobHistoryAmendment,
  ctx: {
    name: string;
    site: { workspaceId: string };
    displacedJobIds: string[];
    jobName: string | undefined;
    actor: ChangeJobActor;
  },
) {
  const changedBy = ctx.actor.employeeId
    ? await prisma.employee.findUnique({
        where: { id: ctx.actor.employeeId },
        select: { version: { select: { firstName: true, lastName: true } } },
      })
    : null;
  publishJobHistoryEvent({
    action: "amended",
    workspaceId: ctx.site.workspaceId,
    siteId: amendment.siteId,
    stationId: amendment.stationId,
    stationName: ctx.name,
    amendmentId: amendment.id,
    jobId: amendment.jobId ?? undefined,
    jobName: ctx.jobName,
    jobVersionId: amendment.jobVersionId ?? undefined,
    displacedJobIds: ctx.displacedJobIds,
    from: amendment.fromTime.toISOString(),
    to: amendment.toTime?.toISOString(),
    changedByEmployeeId: ctx.actor.employeeId,
    changedByEmployeeName: employeeName(changedBy),
    source: ctx.actor.source ?? "MANUAL",
    cause: ctx.actor.cause,
  });
}

export async function listAmendments(filter: { siteId: string; stationId?: string; limit?: number; offset?: number }) {
  const rows = await prisma.jobHistoryAmendment.findMany({
    where: { siteId: filter.siteId, ...(filter.stationId ? { stationId: filter.stationId } : {}) },
    orderBy: { createdAt: "desc" },
    take: filter.limit ?? 50,
    skip: filter.offset ?? 0,
    include: {
      station: { select: { name: true } },
      job: { select: { currentVersion: { select: { name: true } } } },
    },
  });
  const ids = (k: "actorEmployeeId" | "actorUserId") => [
    ...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x)),
  ];
  const [employees, users] = await Promise.all([
    prisma.employee.findMany({
      where: { id: { in: ids("actorEmployeeId") } },
      select: { id: true, version: { select: { firstName: true, lastName: true } } },
    }),
    prisma.user.findMany({ where: { id: { in: ids("actorUserId") } }, select: { id: true, email: true } }),
  ]);
  return rows.map(({ station, job, ...row }) => ({
    ...row,
    stationName: station.name,
    jobName: job?.currentVersion?.name ?? null,
    actorName:
      employeeName(employees.find((e) => e.id === row.actorEmployeeId)) ??
      users.find((u) => u.id === row.actorUserId)?.email ??
      null,
  }));
}

/** Re-publish the amended event so the rebuild consumer picks the amendment up again. */
export async function retryRebuild(
  amendmentId: string,
): Promise<{ data: { amendmentId: string } } | { error: string; code: "NOT_FOUND" }> {
  const amendment = await prisma.jobHistoryAmendment.findUnique({
    where: { id: amendmentId },
    include: {
      station: { select: { name: true, site: { select: { workspaceId: true } } } },
      job: { select: { currentVersion: { select: { name: true } } } },
    },
  });
  if (!amendment) return { error: "Amendment not found", code: "NOT_FOUND" };
  const previous = amendment.previousTimeline as Array<{ jobId: string }>;
  const displacedJobIds = [...new Set(previous.map((r) => r.jobId))].filter((id) => id !== amendment.jobId);
  await prisma.jobHistoryAmendment.update({
    where: { id: amendmentId },
    data: { status: "PENDING_REBUILD", rebuildError: null },
  });
  await publishAmended(amendment, {
    ...amendment.station,
    displacedJobIds,
    jobName: amendment.job?.currentVersion?.name,
    actor: { source: "SYSTEM" },
  });
  return { data: { amendmentId } };
}
