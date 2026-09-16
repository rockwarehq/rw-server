import prisma from "@rw/db";
import { publishUiChange } from "../events/ui-changes.js";
import { ensureBuckets } from "../metrics/bucket.js";
import { jobEntityId } from "../metrics/cascade.js";
import { MetricsContext } from "../metrics/context.js";
import { rebuildStationWindow } from "../metrics/rebuild-window.js";

/**
 * Rebuild the metric buckets over one amendment's window (including zeroing
 * the displaced jobs' buckets). Stock already moved with the items in the
 * amendment transaction. Idempotent — an APPLIED amendment is a no-op.
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
    const ctx = new MetricsContext();
    // The job's own buckets must exist at the window edges before the shared rebuild recomputes them.
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
    await rebuildStationWindow(stationId, siteId, { start: from, end: to }, { jobIds, ctx });
    lap("recalc");
    // Stock moved with the items inside the amendment transaction (see
    // reassignItems); re-deriving a product's total from all history here
    // scaled with the tenant, not the amendment (188s on dev).
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
