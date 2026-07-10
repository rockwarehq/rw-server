import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { inventory } from "../inventory/index.js";
import { allocateInventory } from "../order/allocation.js";
import {
  acquireStationLock,
  applyCycleCompleteTransition,
  findOpenStateEntry,
  loadStationMetricContext,
  publishStationLastCycleMetricEvent,
  publishStationStatusEntityEvent,
  publishStationStatusMetricEvent,
  publishStationStatusReasonMetricEvent,
  type StationMetricContext,
} from "../facility/station/state.js";
import { enqueueDetection, prepareDetection, type PreparedDetection } from "../facility/station/state-detection.js";
import { batchedMetricsUpdate } from "../metrics/batcher.js";
import { incrementHourCounts } from "../metrics/cascade.js";
import { trackReplayedCycle } from "./replay.js";

export interface StartCycleInput {
  stationId: string;
  timestamp: Date;
  jobId: string;
  /** When true, uses the open/close pattern: closes previous open cycle and
   *  opens a new one with end = null. Inventory items are created on the
   *  closed cycle. When false (default), inserts a fully complete cycle
   *  (start + end) with inventory items created immediately. */
  keepOpen?: boolean;
  /** When true, the cycle is from a replayed (buffered) event. Cycle
   *  record and inventory are created normally, but state transitions,
   *  detection timers, and metric rollups are deferred to the replay
   *  reconciliation job. */
  replayed?: boolean;
}

/** Result from all strategy functions — unified so post-commit publishes can share one connection. */
interface StrategyResult {
  cycle: { id: string; start: Date; end: Date | null };
  items: Array<{ id: string; productId: string }>;
  /** Populated only when a state-log row actually closed (period model: most cycles close nothing). */
  closedEntry: { startTime: Date; endTime: Date; state: "UP" | "DOWN" } | null;
  /** Open status after the cycle ("UP" or "SLOW"), or null when the
   * strategy did not evaluate state (replayed paths). */
  newStatus: "UP" | "SLOW" | null;
  /** Status/reason changed vs the prior open row — gates the entity.changes publish. */
  statusChanged: boolean;
  /** Loaded inside the tx so post-commit publishes don't check out their own connections. */
  stationCtx: StationMetricContext | null;
  /** Detection plan computed inside the tx; BullMQ enqueue happens post-commit. */
  detectionPrepared: PreparedDetection | null;
}

/**
 * Record a cycle for a station.
 *
 * Supports two strategies controlled by `keepOpen`:
 *
 * **Default (`keepOpen: false`)** — Inserts a fully complete cycle whose
 * `end` = timestamp and `start` = the previous cycle's `end` on this station
 * (or `timestamp` when no prior cycle exists). Inventory items are created
 * immediately on the new cycle.
 *
 * **Open/close (`keepOpen: true`)** — Closes any open cycles on the station
 * (sets their `end`, creates their inventory items), then opens a new cycle
 * with `end = null`. The new cycle's `start` = timestamp. Inventory items
 * are deferred until this cycle is eventually closed by a future call.
 *
 * All DB work happens in a single transaction — including allocation,
 * detection-prep reads, station-context load, and the HOUR-bucket count
 * increment — so each cycle completion checks out exactly one connection.
 * Redis publishes and BullMQ enqueues run only after the tx commits, so a
 * rollback never leaks observable side effects.
 */
export async function complete(input: StartCycleInput) {
  const { stationId, timestamp, jobId, keepOpen = false, replayed = false } = input;
  const t0 = Date.now();

  // ── Single CTE: validate station + job + fetch tools + items-per-cycle ──
  const setupRows = await prisma.$queryRaw<
    Array<{
      siteId: string;
      jobSiteId: string;
      currentBlobId: string | null;
      standardCycle: number | null;
      slowDetect: number | null;
      jobToolIds: string[];
      toolBlobIds: string[];
      itemsPerCycle: number;
    }>
  >`
    WITH
    setup AS (
      SELECT
        s."siteId",
        j."siteId" AS "jobSiteId",
        j."currentBlobId",
        jb."standardCycle"::float8 AS "standardCycle",
        sb."slowDetect"::float8 AS "slowDetect"
      FROM "Station" s
      JOIN "Job" j ON j.id = ${jobId}
      LEFT JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
      LEFT JOIN "StationBlob" sb ON sb."id" = s."currentBlobId"
      WHERE s.id = ${stationId}
    ),
    tools AS (
      SELECT jt.id, t."currentBlobId" AS "toolBlobId"
      FROM "JobTool" jt
      JOIN "Tool" t ON t.id = jt."toolId"
      WHERE jt."jobId" = ${jobId}::uuid AND jt."deletedAt" IS NULL AND jt."isActive" = true
    ),
    products AS (
      SELECT COALESCE(SUM(jpb.quantity), 1)::int AS total
      FROM "JobProduct" jp
      JOIN "JobProductBlob" jpb ON jpb.id = jp."currentBlobId"
      WHERE jp."jobId" = ${jobId}
        AND jp."deletedAt" IS NULL
        AND jpb."isActive" = true
    )
    SELECT s.*,
           COALESCE(array_agg(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL), '{}') AS "jobToolIds",
           COALESCE(array_agg(DISTINCT t."toolBlobId") FILTER (WHERE t."toolBlobId" IS NOT NULL), '{}') AS "toolBlobIds",
           (SELECT total FROM products) AS "itemsPerCycle"
    FROM setup s
    LEFT JOIN tools t ON true
    GROUP BY s."siteId", s."jobSiteId", s."currentBlobId", s."standardCycle", s."slowDetect"
  `;
  const t1 = Date.now();

  if (setupRows.length === 0) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  const setup = setupRows[0];
  if (!setup.currentBlobId) {
    return { error: "Job has no current blob version", code: "JOB_NO_BLOB" };
  }
  if (setup.siteId !== setup.jobSiteId) {
    return { error: "Job and station must belong to the same site", code: "SITE_MISMATCH" };
  }

  const siteId = setup.siteId;
  const standardCycleSeconds = setup.standardCycle;
  const slowFraction = setup.slowDetect;
  const itemsPerCycle = setup.itemsPerCycle ?? 1;

  let slowThresholdSeconds: number | undefined;
  if (standardCycleSeconds != null && standardCycleSeconds > 0 && slowFraction != null && slowFraction > 0) {
    slowThresholdSeconds = standardCycleSeconds * (1 + slowFraction);
  }

  const blobConnects: BlobConnects = {
    jobBlobId: setup.currentBlobId,
    jobTools: setup.jobToolIds.length > 0 ? { connect: setup.jobToolIds.map((id) => ({ id })) } : undefined,
    toolBlobs: setup.toolBlobIds.length > 0 ? { connect: setup.toolBlobIds.map((id) => ({ id })) } : undefined,
  };

  // ── Execute strategy (single transaction handles ALL DB writes) ──
  const idealCycleIncrement = standardCycleSeconds != null ? Math.round(standardCycleSeconds) : 0;

  const result = replayed
    ? keepOpen
      ? await completeOpenCloseReplay(stationId, siteId, timestamp, jobId, blobConnects)
      : await completeImmediateReplay(stationId, siteId, timestamp, jobId, blobConnects)
    : keepOpen
      ? await completeOpenClose(
          stationId,
          siteId,
          timestamp,
          jobId,
          blobConnects,
          idealCycleIncrement,
          slowThresholdSeconds,
        )
      : await completeImmediate(
          stationId,
          siteId,
          timestamp,
          jobId,
          blobConnects,
          idealCycleIncrement,
          slowThresholdSeconds,
        );
  const { cycle, items, closedEntry, newStatus, statusChanged, stationCtx, detectionPrepared } = result;
  const t2 = Date.now();

  // Material-shift flush is NOT triggered per cycle. The 60s minute tick
  // (`runMetricBucketEnsureTick`) plus the shift-change worker plus the
  // server startup sweep cover it with bounded ≤60s staleness.

  // Replayed cycles: skip state transitions, detection, and metrics.
  // Track the replay window and let the debounced reconciliation job handle it.
  if (replayed) {
    trackReplayedCycle(stationId, siteId, timestamp).catch((err) => {
      console.error(`[cycle] Failed to track replayed cycle for station ${stationId}:`, err);
    });
    console.log(
      `[cycle:timing] station=${stationId} setup=${t1 - t0}ms transaction=${t2 - t1}ms total=${t2 - t0}ms [replayed]`,
    );
    return { data: cycle };
  }

  // ── Post-commit side effects: Redis pub/sub + BullMQ only, no DB connections ──

  const cycleEnd = cycle.end ?? timestamp;
  const cycleDurationSeconds = Math.max(0, (cycleEnd.getTime() - cycle.start.getTime()) / 1000);

  if (detectionPrepared) {
    enqueueDetection(detectionPrepared).catch((err) => {
      console.error(`[station-detection] Failed to schedule detection for station ${stationId}:`, err);
    });
  }

  if (stationCtx) {
    // Period model: publish only on a real transition (SLOW→RUNNING,
    // DOWN→RUNNING, slow fallback) — most cycles change nothing.
    if (newStatus && statusChanged) {
      try {
        publishStationStatusMetricEvent(stationCtx, newStatus, timestamp);
      } catch (err) {
        console.error(`[cycle] publishStationStatusMetric failed for station ${stationId}:`, err);
      }
      // A transition clears any reason carried by the closed DOWN row.
      try {
        publishStationStatusReasonMetricEvent(stationCtx, null, timestamp);
      } catch (err) {
        console.error(`[cycle] publishStationStatusReasonMetric failed for station ${stationId}:`, err);
      }
      try {
        publishStationStatusEntityEvent(stationCtx, ["status", "statusReasonId", "statusStartAt"]);
      } catch (err) {
        console.error(`[cycle] publishStationStatusEntityEvent failed for station ${stationId}:`, err);
      }
    }

    try {
      publishStationLastCycleMetricEvent(stationCtx, cycleDurationSeconds, cycleEnd);
    } catch (err) {
      console.error(`[cycle] publishStationLastCycleMetric failed for station ${stationId}:`, err);
    }
  }

  batchedMetricsUpdate({
    stationId,
    siteId,
    timestamp: cycleEnd,
    itemsCount: items.length,
    standardCycleSeconds: standardCycleSeconds ?? null,
    itemsPerCycle,
    cycleDurationSeconds,
    closedEntry: closedEntry ? { startTime: closedEntry.startTime, endTime: closedEntry.endTime } : undefined,
  });

  const t3 = Date.now();
  console.log(
    `[cycle:timing] station=${stationId} setup=${t1 - t0}ms transaction=${t2 - t1}ms post=${t3 - t2}ms total=${t3 - t0}ms`,
  );

  return { data: cycle };
}

// ── Strategy: immediate (default) ────────────────────────────────
// Insert a fully complete cycle with start + end. Inventory items
// are created immediately on the new cycle. All DB work — cycle row,
// state-log transition, inventory items, order allocation, detection
// reads, station-context load, HOUR bucket count increment — runs in
// one transaction.

async function completeImmediate(
  stationId: string,
  siteId: string,
  timestamp: Date,
  jobId: string,
  blobConnects: BlobConnects,
  idealCycleIncrement: number,
  slowThresholdSeconds?: number,
): Promise<StrategyResult> {
  return prisma.$transaction(async (tx) => {
    // ── CTE: insert cycle + lock + read current state ──
    const cycleRows = await tx.$queryRaw<
      Array<{
        cycle_id: string;
        cycle_start: Date;
        cycle_end: Date;
        state_id: string | null;
        state_start: Date | null;
        state_state: string | null;
        state_status: string | null;
        state_status_reason_id: string | null;
        state_block_id: string | null;
      }>
    >`
      WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext(${stationId}))
      ),
      prev AS (
        SELECT "end" FROM "Cycle"
        WHERE "stationId" = ${stationId} AND "end" IS NOT NULL
        ORDER BY "end" DESC LIMIT 1
      ),
      new_cycle AS (
        INSERT INTO "Cycle" (id, start, "end", "cycleStatus", "siteId", "stationId", "jobBlobId", attrs, "createdAt", "updatedAt")
        VALUES (
          gen_random_uuid(),
          COALESCE((SELECT "end" FROM prev), ${timestamp}),
          ${timestamp},
          'GOOD',
          ${siteId},
          ${stationId},
          ${blobConnects.jobBlobId},
          '{}',
          NOW(),
          NOW()
        )
        RETURNING id, start, "end"
      )
      SELECT
        nc.id AS cycle_id, nc.start AS cycle_start, nc."end" AS cycle_end,
        cs.id AS state_id, cs."startTime" AS state_start, cs.state AS state_state,
        cs.status AS state_status, cs."statusReasonId"::text AS state_status_reason_id,
        cs."blockId" AS state_block_id
      FROM new_cycle nc
      LEFT JOIN "StationStateLog" cs
        ON cs."stationId" = ${stationId} AND cs."endTime" IS NULL AND cs."deletedAt" IS NULL
      CROSS JOIN lock
    `;

    const row = cycleRows[0];
    const cycle = { id: row.cycle_id, start: row.cycle_start, end: row.cycle_end };
    // LEFT JOIN co-nullability: when state_id is non-null, all state_* columns are too.
    const openRow =
      row.state_id && row.state_start && row.state_state && row.state_block_id
        ? {
            id: row.state_id,
            startTime: row.state_start,
            state: row.state_state as "UP" | "DOWN",
            status: row.state_status as "FAST" | "SLOW" | "UP" | "DOWN" | null,
            statusReasonId: row.state_status_reason_id,
            blockId: row.state_block_id,
          }
        : null;

    // ── Batch M2M inserts ──
    if (blobConnects.toolBlobs && blobConnects.toolBlobs.connect.length > 0) {
      const values = Prisma.join(
        blobConnects.toolBlobs.connect.map((tb) => Prisma.sql`(${cycle.id}::uuid, ${tb.id}::uuid)`),
      );
      await tx.$executeRaw`INSERT INTO "_CycleToToolBlob" ("A", "B") VALUES ${values} ON CONFLICT DO NOTHING`;
    }
    if (blobConnects.jobTools && blobConnects.jobTools.connect.length > 0) {
      const values = Prisma.join(
        blobConnects.jobTools.connect.map((jt) => Prisma.sql`(${cycle.id}::uuid, ${jt.id}::uuid)`),
      );
      await tx.$executeRaw`INSERT INTO "_CycleToJobTool" ("A", "B") VALUES ${values} ON CONFLICT DO NOTHING`;
    }

    // Period model: the state log only changes on a real transition
    // (SLOW→RUNNING, DOWN→RUNNING, slow fallback) — most cycles write nothing.
    const cycleDurationSeconds = (timestamp.getTime() - cycle.start.getTime()) / 1000;
    const isSlow =
      cycleDurationSeconds > 0 &&
      slowThresholdSeconds != null &&
      slowThresholdSeconds > 0 &&
      cycleDurationSeconds > slowThresholdSeconds;
    const transition = await applyCycleCompleteTransition(tx, stationId, timestamp, {
      cycleWasSlow: isSlow,
      cycleStart: cycle.start,
      jobBlobId: blobConnects.jobBlobId,
      openRow,
    });

    const items = await inventory.createFromCycle(tx, cycle.id, jobId);

    // Order allocation — was previously fire-and-forget on the global prisma
    // client, now runs serially inside the tx so the whole completion is one
    // connection checkout. Failure rolls the cycle back, matching the new
    // atomicity contract.
    for (const { id, productId } of items) {
      await allocateInventory(tx, siteId, productId, id);
    }

    // Live-publish & detection-schedule data — read inside the tx so the
    // post-commit fire-and-forget block holds no DB connection.
    const stationCtx = await loadStationMetricContext(tx, stationId);
    const detectionPrepared = await prepareDetection(tx, stationId, jobId);

    // HOUR-only count increment — fast single UPDATE on one row.
    // SHIFT/DAY/duration/parent/job rollups are deferred to 5s combined tick.
    const totalCycleIncrement = Math.round(Math.max(0, cycleDurationSeconds));
    await incrementHourCounts(
      tx,
      stationId,
      siteId,
      timestamp,
      1,
      items.length,
      idealCycleIncrement,
      totalCycleIncrement,
    );

    return {
      cycle,
      items,
      closedEntry: transition.closedEntry,
      newStatus: transition.newStatus,
      statusChanged: transition.statusChanged,
      stationCtx,
      detectionPrepared,
    };
  });
}

// ── Strategy: open/close ─────────────────────────────────────────

async function completeOpenClose(
  stationId: string,
  siteId: string,
  timestamp: Date,
  jobId: string,
  blobConnects: BlobConnects,
  idealCycleIncrement: number,
  slowThresholdSeconds?: number,
): Promise<StrategyResult> {
  return prisma.$transaction(async (tx) => {
    const openCycles = await tx.cycle.findMany({
      where: { stationId, end: null },
      select: { id: true, start: true },
    });

    let items: Array<{ id: string; productId: string }> = [];

    if (openCycles.length > 0) {
      const itemArrays = await Promise.all(openCycles.map((oc) => inventory.createFromCycle(tx, oc.id, jobId)));
      items = itemArrays.flat();

      await tx.cycle.updateMany({
        where: { stationId, end: null },
        data: { end: timestamp },
      });
    } else {
      const hasPrevious = await tx.cycle.findFirst({
        where: { stationId },
        select: { id: true },
      });

      if (!hasPrevious) {
        const zeroCycle = await tx.cycle.create({
          data: {
            start: timestamp,
            end: timestamp,
            cycleStatus: "GOOD",
            siteId,
            stationId,
            ...blobConnects,
          },
        });

        items = await inventory.createFromCycle(tx, zeroCycle.id, jobId);
      }
    }

    // Serialize with other state transitions (the lock previously came from transitionToUp).
    await acquireStationLock(tx, stationId);
    const openEntry = await findOpenStateEntry(tx, stationId);
    const cycleDurationSeconds =
      openCycles.length > 0 ? (timestamp.getTime() - openCycles[0].start.getTime()) / 1000 : null;
    const isSlow =
      cycleDurationSeconds != null &&
      cycleDurationSeconds > 0 &&
      slowThresholdSeconds != null &&
      slowThresholdSeconds > 0 &&
      cycleDurationSeconds > slowThresholdSeconds;
    const transition = await applyCycleCompleteTransition(tx, stationId, timestamp, {
      cycleWasSlow: isSlow,
      cycleStart: openCycles[0]?.start ?? timestamp,
      jobBlobId: blobConnects.jobBlobId,
      openRow: openEntry
        ? {
            id: openEntry.id,
            startTime: openEntry.startTime,
            state: openEntry.state,
            status: openEntry.status,
            statusReasonId: openEntry.statusReasonId,
            blockId: openEntry.blockId,
          }
        : null,
    });

    const newCycle = await tx.cycle.create({
      data: {
        start: timestamp,
        cycleStatus: "GOOD",
        siteId,
        stationId,
        ...blobConnects,
      },
    });

    // Order allocation — moved inside the tx; see completeImmediate.
    for (const { id, productId } of items) {
      await allocateInventory(tx, siteId, productId, id);
    }

    const stationCtx = await loadStationMetricContext(tx, stationId);
    const detectionPrepared = await prepareDetection(tx, stationId, jobId);

    // Match the pre-refactor open/close call: HOUR increment was driven off
    // the NEW open cycle whose start = end = timestamp, so totalCycleSeconds
    // contribution per call is 0 on this path. Duration KPIs come from
    // batchDurationRollup on the 5s combined tick, not this per-cycle bump.
    await incrementHourCounts(tx, stationId, siteId, timestamp, 1, items.length, idealCycleIncrement, 0);

    return {
      cycle: newCycle,
      items,
      closedEntry: transition.closedEntry,
      newStatus: transition.newStatus,
      statusChanged: transition.statusChanged,
      stationCtx,
      detectionPrepared,
    };
  });
}

// ── Strategy: immediate replay ──────────────────────────────────

async function completeImmediateReplay(
  stationId: string,
  siteId: string,
  timestamp: Date,
  jobId: string,
  blobConnects: BlobConnects,
): Promise<StrategyResult> {
  return prisma.$transaction(async (tx) => {
    const cycleRows = await tx.$queryRaw<
      Array<{
        cycle_id: string;
        cycle_start: Date;
        cycle_end: Date;
      }>
    >`
      WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext(${stationId}))
      ),
      prev AS (
        SELECT "end" FROM "Cycle"
        WHERE "stationId" = ${stationId} AND "end" IS NOT NULL
        ORDER BY "end" DESC LIMIT 1
      ),
      new_cycle AS (
        INSERT INTO "Cycle" (id, start, "end", "cycleStatus", "siteId", "stationId", "jobBlobId", attrs, "createdAt", "updatedAt")
        VALUES (
          gen_random_uuid(),
          COALESCE((SELECT "end" FROM prev), ${timestamp}),
          ${timestamp},
          'GOOD',
          ${siteId},
          ${stationId},
          ${blobConnects.jobBlobId},
          '{}',
          NOW(),
          NOW()
        )
        RETURNING id, start, "end"
      )
      SELECT nc.id AS cycle_id, nc.start AS cycle_start, nc."end" AS cycle_end
      FROM new_cycle nc
      CROSS JOIN lock
    `;

    const row = cycleRows[0];
    const cycle = { id: row.cycle_id, start: row.cycle_start, end: row.cycle_end };

    // Batch M2M inserts
    if (blobConnects.toolBlobs && blobConnects.toolBlobs.connect.length > 0) {
      const values = Prisma.join(
        blobConnects.toolBlobs.connect.map((tb) => Prisma.sql`(${cycle.id}::uuid, ${tb.id}::uuid)`),
      );
      await tx.$executeRaw`INSERT INTO "_CycleToToolBlob" ("A", "B") VALUES ${values} ON CONFLICT DO NOTHING`;
    }
    if (blobConnects.jobTools && blobConnects.jobTools.connect.length > 0) {
      const values = Prisma.join(
        blobConnects.jobTools.connect.map((jt) => Prisma.sql`(${cycle.id}::uuid, ${jt.id}::uuid)`),
      );
      await tx.$executeRaw`INSERT INTO "_CycleToJobTool" ("A", "B") VALUES ${values} ON CONFLICT DO NOTHING`;
    }

    const items = await inventory.createFromCycle(tx, cycle.id, jobId);

    // Order allocation — replayed cycles allocate too; replay path otherwise
    // skips state transitions, detection, and metrics.
    for (const { id, productId } of items) {
      await allocateInventory(tx, siteId, productId, id);
    }

    return {
      cycle,
      items,
      closedEntry: null,
      newStatus: null,
      statusChanged: false,
      stationCtx: null,
      detectionPrepared: null,
    };
  });
}

// ── Strategy: open/close replay ─────────────────────────────────

async function completeOpenCloseReplay(
  stationId: string,
  siteId: string,
  timestamp: Date,
  jobId: string,
  blobConnects: BlobConnects,
): Promise<StrategyResult> {
  return prisma.$transaction(async (tx) => {
    const openCycles = await tx.cycle.findMany({
      where: { stationId, end: null },
      select: { id: true, start: true },
    });

    let items: Array<{ id: string; productId: string }> = [];

    if (openCycles.length > 0) {
      const itemArrays = await Promise.all(openCycles.map((oc) => inventory.createFromCycle(tx, oc.id, jobId)));
      items = itemArrays.flat();

      await tx.cycle.updateMany({
        where: { stationId, end: null },
        data: { end: timestamp },
      });
    } else {
      const hasPrevious = await tx.cycle.findFirst({
        where: { stationId },
        select: { id: true },
      });

      if (!hasPrevious) {
        const zeroCycle = await tx.cycle.create({
          data: {
            start: timestamp,
            end: timestamp,
            cycleStatus: "GOOD",
            siteId,
            stationId,
            ...blobConnects,
          },
        });

        items = await inventory.createFromCycle(tx, zeroCycle.id, jobId);
      }
    }

    const newCycle = await tx.cycle.create({
      data: {
        start: timestamp,
        cycleStatus: "GOOD",
        siteId,
        stationId,
        ...blobConnects,
      },
    });

    for (const { id, productId } of items) {
      await allocateInventory(tx, siteId, productId, id);
    }

    return {
      cycle: newCycle,
      items,
      closedEntry: null,
      newStatus: null,
      statusChanged: false,
      stationCtx: null,
      detectionPrepared: null,
    };
  });
}

// ── Types ────────────────────────────────────────────────────────

type BlobConnects = {
  jobBlobId: string;
  jobTools?: { connect: { id: string }[] };
  toolBlobs?: { connect: { id: string }[] };
};
