import prisma from "@rw/db";
import * as shiftCommentService from "./shift-comment.js";
import * as shiftSignoffService from "./shift-signoff.js";

// Reads behind a workcenter's shift recap, for one shift instance. No access
// checks here: the signed-in shiftRecap.* procedures check the workcenter
// first, and a deck link (ADR-0018) checks its token and reads only the
// workcenter and shift its edition names.

export interface RecapScope {
  siteId: string;
  shiftInstanceId: string;
  workCenterId: string;
}

async function workcenterStations(siteId: string, workCenterId: string) {
  return prisma.station.findMany({
    where: { siteId, workcenterId: workCenterId },
    select: { id: true, name: true },
  });
}

async function shiftWindow(siteId: string, shiftInstanceId: string) {
  return prisma.shiftInstance.findFirstOrThrow({
    where: { id: shiftInstanceId, siteId },
    select: { startTime: true, endTime: true },
  });
}

/** SHIFT buckets for the workcenter and each of its stations. */
export async function metricBuckets(input: RecapScope) {
  const stationIds = (await workcenterStations(input.siteId, input.workCenterId)).map((s) => s.id);

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
}

/** The jobs that ran on the workcenter's stations during the shift, clamped to it. */
export async function stationJobLogs(input: RecapScope) {
  const shiftInstance = await shiftWindow(input.siteId, input.shiftInstanceId);
  const stationIds = (await workcenterStations(input.siteId, input.workCenterId)).map((s) => s.id);

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
}

/** JOB-entity SHIFT buckets under the workcenter's stations. */
export async function jobMetrics(input: RecapScope) {
  const stationIds = (await workcenterStations(input.siteId, input.workCenterId)).map((s) => s.id);

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
}

/** DOWN periods overlapping the shift, for one station or every station of a workcenter. */
export async function downtimeLogs(input: {
  siteId: string;
  shiftInstanceId: string;
  stationId?: string;
  workCenterId?: string;
}) {
  const shiftInstance = await shiftWindow(input.siteId, input.shiftInstanceId);

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
    const stations = await workcenterStations(input.siteId, input.workCenterId);
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
}

/** Scrap totals by station and reason for the shift. */
export async function scrapByReason(input: RecapScope & { stationId?: string }) {
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
}

/** Operator logons at the workcenter's stations that overlap the shift. */
export async function logons(input: RecapScope) {
  const shiftInstance = await shiftWindow(input.siteId, input.shiftInstanceId);
  const stationIds = (await workcenterStations(input.siteId, input.workCenterId)).map((s) => s.id);
  const rows = await prisma.stationLogonSession.findMany({
    where: {
      stationId: { in: stationIds },
      logonTime: { lt: shiftInstance.endTime },
      OR: [{ logoffTime: { gt: shiftInstance.startTime } }, { logoffTime: null }],
    },
    orderBy: { logonTime: "asc" },
    select: {
      stationId: true,
      logonTime: true,
      logoffTime: true,
      genericName: true,
      display: { select: { name: true } },
      employee: { select: { version: { select: { firstName: true, lastName: true } } } },
    },
  });
  return rows.map((row) => ({
    stationId: row.stationId,
    logonTime: row.logonTime,
    logoffTime: row.logoffTime,
    // Named as logs.logonSearch names them, so one shaping serves both.
    employeeName:
      (row.employee?.version ? `${row.employee.version.firstName} ${row.employee.version.lastName}`.trim() : null) ??
      row.genericName ??
      null,
    displayName: row.display?.name ?? null,
  }));
}

const personName = (person: { firstName: string | null; lastName: string | null } | null | undefined) =>
  person ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() || null : null;

/**
 * Everything the recap draws for one shift, read now: what a deck link shows
 * for its edition's shift. People appear by name only — no emails, ids of
 * users, or employee numbers leave through a link.
 */
export async function recapForShift(input: RecapScope) {
  const [shift, workcenter, site] = await Promise.all([
    prisma.shiftInstance.findFirst({
      where: { id: input.shiftInstanceId, siteId: input.siteId },
      select: { id: true, shiftName: true, businessDate: true, startTime: true, endTime: true, workCenterId: true },
    }),
    prisma.workcenter.findFirst({
      where: { id: input.workCenterId, siteId: input.siteId },
      select: { id: true, name: true },
    }),
    prisma.site.findUnique({ where: { id: input.siteId }, select: { attrs: true } }),
  ]);
  if (!shift || !workcenter) {
    const missing: { error: string; code: string } = { error: "This shift isn't available.", code: "SHIFT_NOT_FOUND" };
    return missing;
  }

  const [stations, buckets, jobLogs, jobs, downtime, scrap, operators, comments, signoff, reasons] = await Promise.all([
    prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true, name: true, currentVersion: { select: { quantityUnit: true } } },
    }),
    metricBuckets(input),
    stationJobLogs(input),
    jobMetrics(input),
    downtimeLogs(input),
    scrapByReason(input),
    logons(input),
    shiftCommentService.list({ shiftInstanceId: input.shiftInstanceId, workcenterId: input.workCenterId }),
    shiftSignoffService.get({ shiftInstanceId: input.shiftInstanceId, workcenterId: input.workCenterId }),
    prisma.statusReason.findMany({
      where: { siteId: input.siteId },
      select: { id: true, name: true, isPlannedDown: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const attrs = (site?.attrs ?? {}) as { statusReasonColors?: { colors?: Record<string, unknown> } };
  const reasonColors = Object.fromEntries(
    Object.entries(attrs.statusReasonColors?.colors ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  return {
    data: {
      shift,
      workcenter,
      // Each with the unit its items are counted in; null counts plain items.
      stations: stations.map((station) => ({
        id: station.id,
        name: station.name,
        quantityUnit: station.currentVersion?.quantityUnit || null,
      })),
      buckets,
      jobLogs,
      jobs,
      downtime,
      scrap,
      operators,
      comments: ("data" in comments ? comments.data : []).map((comment) => ({
        id: comment.id,
        stationId: comment.stationId,
        text: comment.text,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        author: personName(comment.createdBy) ?? personName(comment.createdByEmployee?.version) ?? null,
      })),
      signoff:
        "data" in signoff && signoff.data
          ? { postedAt: signoff.data.postedAt, postedBy: personName(signoff.data.postedBy) }
          : null,
      reasons,
      reasonColors,
    },
  };
}
