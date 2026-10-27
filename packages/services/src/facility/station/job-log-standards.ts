import prisma from "@rw/db";
import { earnedStandardCycleSql } from "../../cycle/amend.js";
import { rebuildStationWindow } from "../../metrics/rebuild-window.js";
import { currentJobLogStandards } from "./effective-standards.js";
import { acquireStationLock } from "./state.js";

/**
 * A running job's or its station's standards changed: put the open job log and
 * the cycles it covers on the current standard, then rebuild the window. The
 * open log starts at the current shift's start (or the job's, if later), so an
 * edit applies to the whole shift so far: most mid-run edits are corrections.
 * Earlier shifts keep their snapshot; amend them to restate.
 *
 * Returns the rebuilt window, or null when nothing needed to change.
 */
export async function applyCurrentStandardsToOpenJobLog(
  stationId: string,
  jobId: string,
  now = new Date(),
): Promise<{ start: Date; end: Date } | null> {
  const changed = await prisma.$transaction(async (tx) => {
    await acquireStationLock(tx, stationId);
    const [station, open, current] = await Promise.all([
      tx.station.findUnique({ where: { id: stationId }, select: { siteId: true } }),
      tx.stationJobLog.findFirst({
        where: { stationId, jobId, endTime: null },
        orderBy: { startTime: "desc" },
      }),
      currentJobLogStandards(tx, stationId, jobId),
    ]);
    if (!station || !open || !current) return null;

    const { log, std } = current;
    const same =
      open.jobVersionId === log.jobVersionId &&
      (open.standardCycle?.toNumber() ?? null) === roundTo(log.standardCycle, 2) &&
      (open.standardQuantity?.toNumber() ?? null) === roundTo(log.standardQuantity, 4) &&
      open.quantityUnit === log.quantityUnit;
    if (same) return null;

    await tx.stationJobLog.update({ where: { id: open.id }, data: log });

    // Attribution by cycle end, matching the bucket tallies.
    await tx.$executeRaw`
      UPDATE "Cycle"
      SET "jobVersionId" = ${log.jobVersionId}::uuid,
          "standardCycle" = ${earnedStandardCycleSql(std)},
          "standardQuantity" = ${std.standardQuantity}::float8,
          "updatedAt" = NOW()
      WHERE "stationId" = ${stationId}::uuid
        AND "jobId" = ${jobId}::uuid
        AND "deletedAt" IS NULL
        AND COALESCE("end", NOW()) >= ${open.startTime}
    `;
    return { siteId: station.siteId, start: open.startTime };
  });
  if (!changed) return null;

  const window = { start: changed.start, end: now };
  await rebuildStationWindow(stationId, changed.siteId, window, { jobIds: [jobId] });
  return window;
}

/** The column's scale, so an unchanged standard compares equal to its stored Decimal. */
function roundTo(value: number | null, places: number): number | null {
  if (value == null) return null;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
