import { unarchiveAffectedBuckets } from "../cycle/replay.js";
import prisma from "@rw/db";
import { ensureBuckets } from "./bucket.js";
import { jobEntityId } from "./cascade.js";
import { getSiteTimezone } from "./bucket.js";
import { MetricsContext } from "./context.js";
import { getBaseBucketForTimestamp, recalcAll } from "./recalc.js";

export interface RebuildWindowOptions {
  /** Jobs whose JOB buckets are rebuilt (and zeroed where no log covers them any more). */
  jobIds?: string[];
  /**
   * Shift boundaries moved: hour and shift buckets are aligned to shift starts,
   * so the ones touching the window are dropped and re-created before recalc.
   */
  realignBuckets?: boolean;
  ctx?: MetricsContext;
}

/**
 * The one way a station's metrics are rebuilt over a window after history
 * changed under them: un-archive what the window touches, (re)create the base
 * buckets, recompute them and roll up. Job history amendments, shift
 * amendments and replay reconciliation all come through here; what differs
 * per caller (which facts were rewritten, whether boundaries moved) is the
 * caller's business and arrives as options.
 */
export async function rebuildStationWindow(
  stationId: string,
  siteId: string,
  window: { start: Date; end: Date },
  { jobIds = [], realignBuckets = false, ctx = new MetricsContext() }: RebuildWindowOptions = {},
): Promise<void> {
  const jobEntities = jobIds.map((id) => jobEntityId(stationId, id));
  await unarchiveAffectedBuckets(stationId, siteId, window.start, window.end, jobEntities);
  if (realignBuckets) {
    await dropShiftAlignedBuckets(siteId, [stationId, ...jobEntities], window);
    const timezone = await getSiteTimezone(siteId, ctx);
    for (let cursor = window.start; cursor < window.end; ) {
      const bucket = await getBaseBucketForTimestamp(stationId, siteId, cursor, timezone, ctx);
      await ensureBuckets({ siteId, entityType: "STATION", entityId: stationId, timestamp: bucket.startTime }, ctx);
      cursor = new Date(bucket.startTime.getTime() + bucket.durationSeconds * 1000);
    }
  }
  await recalcAll(stationId, siteId, window.start, window.end, ctx, jobIds);
}

/**
 * Remove HOUR and SHIFT buckets of these entities that touch the window; recalc
 * rebuilds them on the new boundaries. The archive is cleared too: an old shift's
 * buckets live there, and one left behind keeps a boundary that no longer exists.
 */
export async function dropShiftAlignedBuckets(siteId: string, entityIds: string[], window: { start: Date; end: Date }) {
  for (const table of ["MetricBucket", "MetricBucketLog"]) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${table}"
       WHERE "siteId" = $1::uuid
         AND "entityId" = ANY($2::uuid[])
         AND granularity IN ('HOUR'::"BucketGranularity", 'SHIFT'::"BucketGranularity")
         AND "startTime" < $3
         AND "startTime" + make_interval(secs => "durationSeconds") > $4`,
      siteId,
      entityIds,
      window.end,
      window.start,
    );
  }
}
