import prisma from "@rw/db";
import { publishUiChange } from "../events/ui-changes.js";
import { unarchiveAffectedBuckets } from "../cycle/replay.js";
import { rederiveProductStock } from "../inventory/stock.js";
import { ensureBuckets } from "../metrics/bucket.js";
import { jobEntityId } from "../metrics/cascade.js";
import { MetricsContext } from "../metrics/context.js";
import { recalcAll } from "../metrics/recalc.js";

/**
 * Rebuild the derived data for one amendment: metric buckets over the window
 * (including zeroing the displaced jobs' buckets) and product stock when items
 * were recreated. Idempotent — an APPLIED amendment is a no-op.
 */
export async function rebuildForAmendment(amendmentId: string, displacedJobIds: string[]): Promise<void> {
  const amendment = await prisma.jobHistoryAmendment.findUnique({
    where: { id: amendmentId },
    include: { job: { select: { currentVersion: { select: { name: true } } } } },
  });
  if (!amendment || amendment.status === "APPLIED") return;

  const { siteId, stationId, fromTime: from } = amendment;
  const to = amendment.toTime ?? new Date();
  const jobIds = [...new Set([...displacedJobIds, ...(amendment.jobId ? [amendment.jobId] : [])])];
  try {
    await unarchiveAffectedBuckets(
      stationId,
      siteId,
      from,
      to,
      jobIds.map((id) => jobEntityId(stationId, id)),
    );
    const ctx = new MetricsContext();
    if (amendment.jobId) {
      const entity = {
        siteId,
        entityType: "JOB" as const,
        entityId: jobEntityId(stationId, amendment.jobId),
        entityName: amendment.job?.currentVersion?.name ?? "",
      };
      await ensureBuckets({ ...entity, timestamp: from }, ctx);
      if (!amendment.toTime) await ensureBuckets({ ...entity, timestamp: to }, ctx);
    }
    await recalcAll(stationId, siteId, from, to, ctx, jobIds);
    const summary = amendment.summary as { itemsCreated?: number };
    if (summary.itemsCreated) await rederiveProductStock(siteId);
    await prisma.jobHistoryAmendment.update({
      where: { id: amendmentId },
      data: { status: "APPLIED", rebuiltAt: new Date(), rebuildError: null },
    });
    publishUiChange({ kind: "job-history.rebuilt", siteId, stationId, amendmentId, status: "APPLIED" });
  } catch (err) {
    await prisma.jobHistoryAmendment.update({
      where: { id: amendmentId },
      data: { status: "FAILED", rebuildError: err instanceof Error ? err.message : String(err) },
    });
    publishUiChange({ kind: "job-history.rebuilt", siteId, stationId, amendmentId, status: "FAILED" });
    throw err;
  }
}
