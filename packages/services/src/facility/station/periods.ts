import prisma from "@rw/db";
import type { Prisma, StationJobLog } from "@rw/db";
import { resolveShiftStamp, type ShiftStamp } from "../work-context.js";
import { createStationJobLog } from "./jobs.js";
import { acquireStationLock, findOpenStateEntry, splitStateEntryAt } from "./state.js";

// Period rows (StationStateLog, StationJobLog) belong to exactly one shift:
// a row that reaches a shift boundary is cut there and continued with the
// boundary's stamp under the same blockId (ADR-0014).
//
// TODO (revisit before PR): StationModeLog has the same period shape and is
// NOT cut here (ADR-0014, last consequence). So `modePeriods` in the report
// catalog still attributes a mode stretch wholly to the shift it started in,
// and unlike the other two tables that is not just a legacy gap — the writer
// keeps producing spanning rows, so backfilling mode rows alone would regrow.
// Fix is this same path (add the open mode row to
// splitOpenPeriodsAtShiftBoundaries and give it a cutModeLog), then include
// StationModeLog in the period backfill.

type Tx = Prisma.TransactionClient;

export interface StationScope {
  id: string;
  siteId: string;
  workcenterId: string | null;
}

interface Period {
  startTime: Date;
  endTime: Date | null;
  shiftInstanceId: string | null;
}

/** Shift starts and ends in the station's scope within (after, until], ascending. */
async function shiftBoundaries(tx: Tx, station: StationScope, after: Date, until: Date): Promise<Date[]> {
  if (after >= until) return [];
  const window = { gt: after, lte: until };
  const rows = await tx.shiftInstance.findMany({
    where: {
      siteId: station.siteId,
      AND: [
        { OR: [{ workCenterId: null }, { workCenterId: station.workcenterId }] },
        { OR: [{ startTime: window }, { endTime: window }] },
      ],
    },
    select: { startTime: true, endTime: true },
  });
  const instants = new Set<number>();
  for (const r of rows) {
    for (const t of [r.startTime, r.endTime]) if (t > after && t <= until) instants.add(t.getTime());
  }
  return [...instants].sort((a, b) => a - b).map((ms) => new Date(ms));
}

/**
 * Cut `row` at every shift boundary it spans (up to `until` for open rows)
 * where the shift stamp changes; `cut` performs one split and returns the
 * continuation. Returns the last piece.
 */
export async function cutAtShiftBoundaries<R extends Period>(
  tx: Tx,
  station: StationScope,
  row: R,
  until: Date,
  cut: (row: R, at: Date, stamp: ShiftStamp) => Promise<R>,
): Promise<R> {
  const end = row.endTime && row.endTime < until ? row.endTime : until;
  let current = row;
  for (const at of await shiftBoundaries(tx, station, row.startTime, end)) {
    if (current.endTime && at >= current.endTime) break;
    const stamp = await resolveShiftStamp(station.siteId, station.workcenterId, at, tx);
    if (stamp.shiftInstanceId === current.shiftInstanceId) continue;
    current = await cut(current, at, stamp);
  }
  return current;
}

export const cutStateEntry =
  (tx: Tx) => async (row: Parameters<typeof splitStateEntryAt>[1], at: Date, stamp: ShiftStamp) =>
    (await splitStateEntryAt(tx, row, at, stamp))[1];

export const cutJobLog = (tx: Tx, station: StationScope) => async (row: StationJobLog, at: Date) => {
  await tx.stationJobLog.update({ where: { id: row.id }, data: { endTime: at } });
  return createStationJobLog(tx, station, {
    blockId: row.blockId,
    jobId: row.jobId,
    jobVersionId: row.jobVersionId,
    startTime: at,
    endTime: row.endTime,
    standardCycle: row.standardCycle?.toNumber() ?? null,
    standardQuantity: row.standardQuantity?.toNumber() ?? null,
    quantityUnit: row.quantityUnit,
  });
};

/** Cut the station's open state row and open job log at any boundary they have crossed. Caller holds the lock. */
export async function splitOpenPeriodsAtShiftBoundaries(
  tx: Tx,
  station: StationScope,
  now = new Date(),
): Promise<void> {
  const [state, job] = await Promise.all([
    findOpenStateEntry(tx, station.id),
    tx.stationJobLog.findFirst({ where: { stationId: station.id, endTime: null }, orderBy: { startTime: "desc" } }),
  ]);
  if (state) await cutAtShiftBoundaries(tx, station, state, now, cutStateEntry(tx));
  if (job) await cutAtShiftBoundaries(tx, station, job, now, cutJobLog(tx, station));
}

/** Ensure-tick sweep: every station whose open rows are stamped with a shift other than the one running now. */
export async function splitOpenPeriodsForAllStations(now = new Date()): Promise<number> {
  const stations = await prisma.$queryRaw<StationScope[]>`
    WITH cur AS (
      SELECT s.id, s."siteId", s."workcenterId",
        (SELECT si.id FROM "ShiftInstance" si
         WHERE si."siteId" = s."siteId"
           AND (si."workCenterId" = s."workcenterId" OR si."workCenterId" IS NULL)
           AND si."startTime" <= ${now} AND si."endTime" > ${now}
         ORDER BY si."workCenterId" NULLS LAST, si."startTime" DESC
         LIMIT 1) AS shift_id
      FROM "Station" s
      WHERE s."deletedAt" IS NULL
    )
    SELECT id, "siteId", "workcenterId" FROM cur
    WHERE EXISTS (
        SELECT 1 FROM "StationStateLog" l
        WHERE l."stationId" = cur.id AND l."endTime" IS NULL AND l."deletedAt" IS NULL
          AND l."shiftInstanceId" IS DISTINCT FROM cur.shift_id)
      OR EXISTS (
        SELECT 1 FROM "StationJobLog" l
        WHERE l."stationId" = cur.id AND l."endTime" IS NULL
          AND l."shiftInstanceId" IS DISTINCT FROM cur.shift_id)
  `;
  for (const station of stations) {
    await prisma.$transaction(async (tx) => {
      await acquireStationLock(tx, station.id);
      await splitOpenPeriodsAtShiftBoundaries(tx, station, now);
    });
  }
  return stations.length;
}
