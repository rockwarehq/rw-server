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
  // Per-phase timing so a slow tenant's log says where a rebuild spends its time.
  const laps: string[] = [];
  let lapStart = Date.now();
  const lap = (label: string) => {
    laps.push(`${label}=${Date.now() - lapStart}ms`);
    lapStart = Date.now();
  };
  const t0 = lapStart;
  try {
    await unarchiveAffectedBuckets(
      stationId,
      siteId,
      from,
      to,
      jobIds.map((id) => jobEntityId(stationId, id)),
    );
    lap("unarchive");
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
    lap("ensure");
    await recalcAll(stationId, siteId, from, to, ctx, jobIds);
    lap("recalc");
    const summary = amendment.summary as { itemsCreated?: number };
    if (summary.itemsCreated) {
      // Only the products of the jobs involved changed hands.
      const products = await prisma.jobProduct.findMany({
        where: { jobId: { in: jobIds } },
        select: { productId: true },
      });
      await rederiveProductStock(siteId, [...new Set(products.map((p) => p.productId))]);
      lap("stock");
    }
    await prisma.jobHistoryAmendment.update({
      where: { id: amendmentId },
      data: { status: "APPLIED", rebuiltAt: new Date(), rebuildError: null },
    });
    console.log(
      `[job-history-rebuild] amendment ${amendmentId} station=${stationId} ${from.toISOString()}..${to.toISOString()} ` +
        `${laps.join(" ")} total=${Date.now() - t0}ms`,
    );
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
