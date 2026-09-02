import type prisma from "@rw/db";
import type { Prisma } from "@rw/db";

type Client = Prisma.TransactionClient | typeof prisma;

export interface OpenModeLog {
  modeId: string;
  scrapAll: boolean;
  itemDispositionId: string | null;
  dispositionReasonId: string | null;
  /** Default downtime reason for DOWN periods that begin under this mode. */
  statusReasonId: string | null;
}

/** The station's active mode log entry (endTime IS NULL), or null. */
export async function findOpenModeLog(client: Client, stationId: string): Promise<OpenModeLog | null> {
  const row = await client.stationModeLog.findFirst({
    where: { stationId, endTime: null },
    select: {
      modeId: true,
      mode: { select: { scrapAll: true, itemDispositionId: true, dispositionReasonId: true, statusReasonId: true } },
    },
  });
  if (!row) return null;
  return {
    modeId: row.modeId,
    scrapAll: row.mode.scrapAll,
    itemDispositionId: row.mode.itemDispositionId,
    dispositionReasonId: row.mode.dispositionReasonId,
    statusReasonId: row.mode.statusReasonId,
  };
}
