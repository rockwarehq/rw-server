import type { AmendContext } from "../../history/context.js";
import { resolveJobDimensions } from "../work-context.js";
import { cutAtShiftBoundaries, cutStateEntry } from "./periods.js";
import { splitStateEntryAt } from "./state.js";

/**
 * Cut the status periods at the window edges and stamp the amended job on
 * every period inside it (ADR-0005: one status and one job per row). Statuses,
 * reasons and blocks stay as recorded.
 */
export async function restampStateLog(ctx: AmendContext, to: Date | null): Promise<number> {
  const { tx, stationId, from, job } = ctx;
  for (const at of to ? [from, to] : [from]) {
    const entry = await tx.stationStateLog.findFirst({
      where: { stationId, deletedAt: null, startTime: { lt: at }, OR: [{ endTime: { gt: at } }, { endTime: null }] },
    });
    if (entry) await splitStateEntryAt(tx, entry, at);
  }
  const { count } = await tx.stationStateLog.updateMany({
    where: { stationId, deletedAt: null, startTime: { gte: from, ...(to ? { lt: to } : {}) } },
    data: { jobId: job?.id ?? null, jobVersionId: job?.versionId ?? null },
  });
  const station = { id: stationId, siteId: ctx.siteId, workcenterId: ctx.workcenterId };
  const rows = await tx.stationStateLog.findMany({
    where: { stationId, deletedAt: null, startTime: { gte: from, lt: ctx.toEff } },
  });
  for (const row of rows) await cutAtShiftBoundaries(tx, station, row, ctx.toEff, cutStateEntry(tx));
  return count;
}

/** Calls and mode logs that opened in the window carry the job's BI dimensions. */
export async function restampCallsAndModes(ctx: AmendContext): Promise<{ calls: number; modeLogs: number }> {
  const { tx, stationId, from, toEff, job } = ctx;
  const dims = { ...(await resolveJobDimensions(job?.id ?? null)), jobVersionId: job?.versionId ?? null };
  const [calls, modeLogs] = await Promise.all([
    tx.call.updateMany({ where: { stationId, openedAt: { gte: from, lt: toEff } }, data: dims }),
    tx.stationModeLog.updateMany({ where: { stationId, startTime: { gte: from, lt: toEff } }, data: dims }),
  ]);
  return { calls: calls.count, modeLogs: modeLogs.count };
}
