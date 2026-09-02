import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { publishEntityEvent } from "../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../entity/registry.js";
import { findOpenModeLog, type OpenModeLog } from "../facility/production-mode/open-log.js";
import { autoScrapCycleItems } from "../inventory/disposition-log.js";
import { inventory } from "../inventory/index.js";
import { applyProduction } from "../inventory/stock.js";
import { updateDispositionBadItems } from "../metrics/recalc.js";
import { checkAutoComplete } from "../order/auto-complete.js";
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
import {
  quantityWasSlow,
  resolveCycleActuals,
  resolveStandards,
  type CycleStamp,
  type ResolvedStandards,
} from "./standards.js";

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
  /** Livestore hook-event id that produced this cycle. */
  sourceEventId?: string;
  /** Measured quantity carried by the cycle event; resolved per cycle mode — see cycle/standards.ts. */
  quantity?: number;
}

type CycleItems = Array<{
  id: string;
  cycleId: string;
  productId: string;
  quantity: number;
  productVersionId: string;
  jobProductVersionId: string | null;
  toolVersionId: string | null;
  toolCavityVersionId: string | null;
}>;

function sumItemQuantities(items: CycleItems): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

/**
 * Post-commit stock side effects: one Product `stock` refresh hint per
 * distinct product, then the auto-complete rule (fire-and-forget — never
 * awaited on the cycle path, never inside the tx).
 */
function publishStockEffects(siteId: string, workspaceId: string, items: CycleItems): void {
  const productIds = [...new Set(items.map((item) => item.productId))];
  for (const productId of productIds) {
    publishEntityEvent({
      action: "updated",
      entityKey: SYSTEM_ENTITY_KEYS.Product,
      entityId: productId,
      siteId,
      workspaceId,
      changedFields: ["stock"],
    });
  }
  if (productIds.length > 0) {
    checkAutoComplete(siteId, productIds).catch((err) => {
      console.error(`[cycle] order auto-complete check failed for site ${siteId}:`, err);
    });
  }
}

/** Result from all strategy functions — unified so post-commit publishes can share one connection. */
interface StrategyResult {
  cycle: { id: string; start: Date; end: Date | null };
  items: CycleItems;
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
  /** Items auto-scrapped by a scrapAll production mode; badItems bump happens post-commit. */
  scrappedQuantity: number;
}

/** Scrap the cycle's items when the station's active mode says so. */
async function applyModeScrap(
  tx: Prisma.TransactionClient,
  siteId: string,
  stationId: string,
  mode: OpenModeLog | null,
  items: CycleItems,
): Promise<number> {
  if (!mode?.scrapAll || !mode.itemDispositionId || !mode.dispositionReasonId || items.length === 0) return 0;
  return autoScrapCycleItems(tx, {
    siteId,
    stationId,
    modeId: mode.modeId,
    itemDispositionId: mode.itemDispositionId,
    dispositionReasonId: mode.dispositionReasonId,
    items,
  });
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
 * All DB work happens in a single transaction — including the stock upsert,
 * detection-prep reads, station-context load, and the HOUR-bucket count
 * increment — so each cycle completion checks out exactly one connection.
 * Redis publishes and BullMQ enqueues run only after the tx commits, so a
 * rollback never leaks observable side effects.
 */
export async function complete(input: StartCycleInput) {
  const { stationId, timestamp, jobId, keepOpen = false, replayed = false, sourceEventId = null, quantity } = input;
  const t0 = Date.now();

  // Redelivery fast path: a cycle already recorded for this event returns
  // without paying the setup query or the transaction.
  if (sourceEventId) {
    const existing = await findBySourceEventId(sourceEventId);
    if (existing) return { data: existing, alreadyRecorded: true as const };
  }

  // ── Single CTE: validate station + job + fetch tools + standards config ──
  const setupRows = await prisma.$queryRaw<
    Array<{
      siteId: string;
      workspaceId: string;
      jobSiteId: string;
      currentVersionId: string | null;
      standardCycle: number | null;
      slowDetect: number | null;
      cycleMode: string | null;
      stationStandardQuantity: number | null;
      stationQuantityUnit: string | null;
      stationStandardCycle: number | null;
      stationStandardRate: number | null;
      stationStandardRateUnit: string | null;
      stationStandardRatePeriod: string | null;
      standardRate: number | null;
      standardRateUnit: string | null;
      standardRatePeriod: string | null;
      jobStandardQuantity: number | null;
      jobToolIds: string[];
      toolVersionIds: string[];
    }>
  >`
    WITH
    setup AS (
      SELECT
        s."siteId",
        si."workspaceId",
        j."siteId" AS "jobSiteId",
        j."currentVersionId",
        jb."standardCycle"::float8 AS "standardCycle",
        sb."slowDetect"::float8 AS "slowDetect",
        sb."cycleMode"::text AS "cycleMode",
        sb."standardQuantity"::float8 AS "stationStandardQuantity",
        sb."quantityUnit" AS "stationQuantityUnit",
        sb."standardCycle"::float8 AS "stationStandardCycle",
        sb."standardRate"::float8 AS "stationStandardRate",
        sb."standardRateUnit" AS "stationStandardRateUnit",
        sb."standardRatePeriod"::text AS "stationStandardRatePeriod",
        jb."standardRate"::float8 AS "standardRate",
        jb."standardRateUnit" AS "standardRateUnit",
        jb."standardRatePeriod"::text AS "standardRatePeriod",
        jb."standardQuantity"::float8 AS "jobStandardQuantity"
      FROM "Station" s
      JOIN "Site" si ON si.id = s."siteId"
      JOIN "Job" j ON j.id = ${jobId}
      LEFT JOIN "JobVersion" jb ON jb.id = j."currentVersionId"
      LEFT JOIN "StationVersion" sb ON sb."id" = s."currentVersionId"
      WHERE s.id = ${stationId}
    ),
    tools AS (
      SELECT jt.id, t."currentVersionId" AS "toolVersionId"
      FROM "JobTool" jt
      JOIN "Tool" t ON t.id = jt."toolId"
      WHERE jt."jobId" = ${jobId}::uuid AND jt."deletedAt" IS NULL AND jt."isActive" = true
    )
    SELECT s.*,
           COALESCE(array_agg(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL), '{}') AS "jobToolIds",
           COALESCE(array_agg(DISTINCT t."toolVersionId") FILTER (WHERE t."toolVersionId" IS NOT NULL), '{}') AS "toolVersionIds"
    FROM setup s
    LEFT JOIN tools t ON true
    GROUP BY s."siteId", s."workspaceId", s."jobSiteId", s."currentVersionId", s."standardCycle", s."slowDetect",
             s."cycleMode", s."stationStandardQuantity", s."stationQuantityUnit", s."stationStandardCycle",
             s."stationStandardRate", s."stationStandardRateUnit", s."stationStandardRatePeriod",
             s."standardRate", s."standardRateUnit", s."standardRatePeriod", s."jobStandardQuantity"
  `;
  const t1 = Date.now();

  if (setupRows.length === 0) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  const setup = setupRows[0];
  if (!setup.currentVersionId) {
    return { error: "Job has no current version version", code: "JOB_NO_VERSION" };
  }
  if (setup.siteId !== setup.jobSiteId) {
    return { error: "Job and station must belong to the same site", code: "SITE_MISMATCH" };
  }

  const siteId = setup.siteId;
  const slowFraction = setup.slowDetect;

  const std = resolveStandards({
    cycleMode: setup.cycleMode,
    stationStandardQuantity: setup.stationStandardQuantity,
    stationQuantityUnit: setup.stationQuantityUnit,
    stationStandardCycle: setup.stationStandardCycle,
    stationStandardRate: setup.stationStandardRate,
    stationStandardRateUnit: setup.stationStandardRateUnit,
    stationStandardRatePeriod: setup.stationStandardRatePeriod,
    jobStandardCycle: setup.standardCycle,
    jobStandardRate: setup.standardRate,
    jobStandardRateUnit: setup.standardRateUnit,
    jobStandardRatePeriod: setup.standardRatePeriod,
    jobStandardQuantity: setup.jobStandardQuantity,
  });
  const standardCycleSeconds = std.standardCycleSeconds;
  const cycleStamp = resolveCycleActuals(std, quantity ?? null);

  let slowThresholdSeconds: number | undefined;
  if (standardCycleSeconds != null && standardCycleSeconds > 0 && slowFraction != null && slowFraction > 0) {
    slowThresholdSeconds = standardCycleSeconds * (1 + slowFraction);
  }
  // Interval mode: slow is a quantity shortfall, not lateness.
  const slowByQuantity = quantityWasSlow(std, cycleStamp.quantity, slowFraction);

  const versionConnects: VersionConnects = {
    jobVersionId: setup.currentVersionId,
    jobTools: setup.jobToolIds.length > 0 ? { connect: setup.jobToolIds.map((id) => ({ id })) } : undefined,
    toolVersions: setup.toolVersionIds.length > 0 ? { connect: setup.toolVersionIds.map((id) => ({ id })) } : undefined,
  };

  // ── Execute strategy (single transaction handles ALL DB writes) ──
  // Earned standard — for DISCRETE identical to the old standardCycle round.
  const idealCycleIncrement = cycleStamp.standardCycle != null ? Math.round(cycleStamp.standardCycle) : 0;

  const result = replayed
    ? keepOpen
      ? await completeOpenCloseReplay(stationId, siteId, timestamp, jobId, versionConnects, sourceEventId, cycleStamp)
      : await completeImmediateReplay(stationId, siteId, timestamp, jobId, versionConnects, sourceEventId, cycleStamp)
    : keepOpen
      ? await completeOpenClose(
          stationId,
          siteId,
          timestamp,
          jobId,
          versionConnects,
          idealCycleIncrement,
          sourceEventId,
          slowThresholdSeconds,
          cycleStamp,
          slowByQuantity,
          std,
        )
      : await completeImmediate(
          stationId,
          siteId,
          timestamp,
          jobId,
          versionConnects,
          idealCycleIncrement,
          sourceEventId,
          slowThresholdSeconds,
          cycleStamp,
          slowByQuantity,
          std,
        );

  // Null strategy result = lost the sourceEventId insert race to a concurrent
  // delivery of the same event; the winner's row is committed by now.
  if (!result) {
    const existing = sourceEventId ? await findBySourceEventId(sourceEventId) : null;
    if (!existing) return { error: "Cycle already recorded for this event", code: "DUPLICATE_EVENT" };
    console.log(`[cycle] duplicate event ${sourceEventId} for station ${stationId}; already cycle ${existing.id}`);
    return { data: existing, alreadyRecorded: true as const };
  }

  const { cycle, closedEntry, newStatus, statusChanged, stationCtx, detectionPrepared } = result;
  const t2 = Date.now();

  // Material-shift flush is NOT triggered per cycle. The 60s minute tick
  // (`runMetricBucketEnsureTick`) plus the shift-change worker plus the
  // server startup sweep cover it with bounded ≤60s staleness.

  // Replayed cycles: skip state transitions, detection, and metrics.
  // Track the replay window and let the debounced reconciliation job handle it.
  if (replayed) {
    publishStockEffects(siteId, setup.workspaceId, result.items);
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
    closedEntry: closedEntry ? { startTime: closedEntry.startTime, endTime: closedEntry.endTime } : undefined,
  });

  // Mode scrap logs committed with the cycle; bump badItems like a manual disposition.
  if (result.scrappedQuantity > 0) {
    updateDispositionBadItems(stationId, siteId, cycleEnd, result.scrappedQuantity).catch((err) => {
      console.error(`[cycle] Failed to update badItems for mode scrap on station ${stationId}:`, err);
    });
  }

  publishStockEffects(siteId, setup.workspaceId, result.items);

  const t3 = Date.now();
  console.log(
    `[cycle:timing] station=${stationId} setup=${t1 - t0}ms transaction=${t2 - t1}ms post=${t3 - t2}ms total=${t3 - t0}ms`,
  );

  return { data: cycle };
}

// ── Strategy: immediate (default) ────────────────────────────────
// Insert a fully complete cycle with start + end. Inventory items
// are created immediately on the new cycle. All DB work — cycle row,
// state-log transition, inventory items, stock upsert, detection
// reads, station-context load, HOUR bucket count increment — runs in
// one transaction.

async function completeImmediate(
  stationId: string,
  siteId: string,
  timestamp: Date,
  jobId: string,
  versionConnects: VersionConnects,
  idealCycleIncrement: number,
  sourceEventId: string | null,
  slowThresholdSeconds: number | undefined,
  stamp: CycleStamp,
  slowByQuantity: boolean,
  std: ResolvedStandards,
): Promise<StrategyResult | null> {
  return prisma.$transaction(async (tx) => {
    // Per-station advisory lock as its own statement BEFORE the prev-cycle
    // read. Taking it via a CTE in the statement below does not serialize:
    // Postgres evaluates the lock CTE lazily, after the reads.
    await acquireStationLock(tx, stationId);

    const mode = await findOpenModeLog(tx, stationId);

    // ── CTE: insert cycle + read current state ──
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
      WITH prev AS (
        SELECT "end" FROM "Cycle"
        WHERE "stationId" = ${stationId} AND "end" IS NOT NULL
        ORDER BY "end" DESC LIMIT 1
      ),
      new_cycle AS (
        INSERT INTO "Cycle" (id, start, "end", "cycleStatus", quantity, "quantityUnit", "standardCycle", "standardQuantity", "siteId", "stationId", "jobVersionId", "sourceEventId", "modeId", attrs, "createdAt", "updatedAt")
        VALUES (
          gen_random_uuid(),
          COALESCE((SELECT "end" FROM prev), ${timestamp}),
          ${timestamp},
          'GOOD',
          ${stamp.quantity},
          ${stamp.quantityUnit},
          ${stamp.standardCycle},
          ${stamp.standardQuantity},
          ${siteId},
          ${stationId},
          ${versionConnects.jobVersionId},
          ${sourceEventId}::uuid,
          ${mode?.modeId ?? null}::uuid,
          '{}',
          NOW(),
          NOW()
        )
        ON CONFLICT ("sourceEventId") DO NOTHING
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
    `;

    const row = cycleRows[0];
    // ON CONFLICT DO NOTHING on sourceEventId: a concurrent delivery already
    // recorded this event. The insert is the only write so far — bail before
    // the M2M/transition/inventory/stock/metric statements.
    if (!row) return null;
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
    if (versionConnects.toolVersions && versionConnects.toolVersions.connect.length > 0) {
      const values = Prisma.join(
        versionConnects.toolVersions.connect.map((tb) => Prisma.sql`(${cycle.id}::uuid, ${tb.id}::uuid)`),
      );
      await tx.$executeRaw`INSERT INTO "_CycleToToolVersion" ("A", "B") VALUES ${values} ON CONFLICT DO NOTHING`;
    }
    if (versionConnects.jobTools && versionConnects.jobTools.connect.length > 0) {
      const values = Prisma.join(
        versionConnects.jobTools.connect.map((jt) => Prisma.sql`(${cycle.id}::uuid, ${jt.id}::uuid)`),
      );
      await tx.$executeRaw`INSERT INTO "_CycleToJobTool" ("A", "B") VALUES ${values} ON CONFLICT DO NOTHING`;
    }

    // Period model: the state log only changes on a real transition
    // (SLOW→RUNNING, DOWN→RUNNING, slow fallback) — most cycles write nothing.
    const cycleDurationSeconds = (timestamp.getTime() - cycle.start.getTime()) / 1000;
    const isSlow =
      (cycleDurationSeconds > 0 &&
        slowThresholdSeconds != null &&
        slowThresholdSeconds > 0 &&
        cycleDurationSeconds > slowThresholdSeconds) ||
      slowByQuantity;
    const transition = await applyCycleCompleteTransition(tx, stationId, timestamp, {
      cycleWasSlow: isSlow,
      cycleStart: cycle.start,
      jobVersionId: versionConnects.jobVersionId,
      modeId: mode?.modeId ?? null,
      openRow,
    });

    const items = await inventory.createFromCycle(tx, cycle.id, jobId, stamp, mode?.modeId);
    const scrappedQuantity = await applyModeScrap(tx, siteId, stationId, mode, items);

    // Live-publish & detection-schedule data — read inside the tx so the
    // post-commit fire-and-forget block holds no DB connection.
    const stationCtx = await loadStationMetricContext(tx, stationId);
    const detectionPrepared = await prepareDetection(tx, stationId, jobId, std);

    // HOUR-only count increment — fast single UPDATE on one row.
    // SHIFT/DAY/duration/parent/job rollups are deferred to 5s combined tick.
    const totalCycleIncrement = Math.round(Math.max(0, cycleDurationSeconds));
    await incrementHourCounts(
      tx,
      stationId,
      siteId,
      timestamp,
      1,
      Math.round(sumItemQuantities(items)),
      idealCycleIncrement,
      totalCycleIncrement,
    );

    // On-hand stock upsert — last in the tx to keep the per-product row-lock
    // window minimal under cross-station same-product contention.
    await applyProduction(tx, siteId, items);

    return {
      cycle,
      items,
      closedEntry: transition.closedEntry,
      newStatus: transition.newStatus,
      statusChanged: transition.statusChanged,
      stationCtx,
      detectionPrepared,
      scrappedQuantity,
    };
  });
}

// ── Strategy: open/close ─────────────────────────────────────────

async function completeOpenClose(
  stationId: string,
  siteId: string,
  timestamp: Date,
  jobId: string,
  versionConnects: VersionConnects,
  idealCycleIncrement: number,
  sourceEventId: string | null,
  slowThresholdSeconds: number | undefined,
  stamp: CycleStamp,
  slowByQuantity: boolean,
  std: ResolvedStandards,
): Promise<StrategyResult | null> {
  return prisma
    .$transaction(async (tx) => {
      // Cross-process serialization, before ANY read — see completeImmediate.
      await acquireStationLock(tx, stationId);

      const mode = await findOpenModeLog(tx, stationId);

      const openCycles = await tx.cycle.findMany({
        where: { stationId, end: null },
        select: { id: true, start: true },
      });

      let items: CycleItems = [];

      if (openCycles.length > 0) {
        const itemArrays = await Promise.all(
          openCycles.map((oc) => inventory.createFromCycle(tx, oc.id, jobId, stamp, mode?.modeId)),
        );
        items = itemArrays.flat();

        // The closing event's quantity/earned-standard belong to the cycle being closed.
        await tx.cycle.updateMany({
          where: { stationId, end: null },
          data: { end: timestamp, ...stamp },
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
              ...stamp,
              siteId,
              stationId,
              modeId: mode?.modeId ?? null,
              ...versionConnects,
            },
          });

          items = await inventory.createFromCycle(tx, zeroCycle.id, jobId, stamp, mode?.modeId);
        }
      }

      const scrappedQuantity = await applyModeScrap(tx, siteId, stationId, mode, items);

      const openEntry = await findOpenStateEntry(tx, stationId);
      const cycleDurationSeconds =
        openCycles.length > 0 ? (timestamp.getTime() - openCycles[0].start.getTime()) / 1000 : null;
      const isSlow =
        (cycleDurationSeconds != null &&
          cycleDurationSeconds > 0 &&
          slowThresholdSeconds != null &&
          slowThresholdSeconds > 0 &&
          cycleDurationSeconds > slowThresholdSeconds) ||
        slowByQuantity;
      const transition = await applyCycleCompleteTransition(tx, stationId, timestamp, {
        cycleWasSlow: isSlow,
        cycleStart: openCycles[0]?.start ?? timestamp,
        jobVersionId: versionConnects.jobVersionId,
        modeId: mode?.modeId ?? null,
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

      // The event is stamped on the NEW open cycle (not the closed one): a
      // redelivered event then hits the unique violation here and the rollback
      // undoes the close above — the first delivery owns that transition.
      const newCycle = await tx.cycle.create({
        data: {
          start: timestamp,
          cycleStatus: "GOOD",
          siteId,
          stationId,
          sourceEventId,
          modeId: mode?.modeId ?? null,
          ...versionConnects,
        },
      });

      const stationCtx = await loadStationMetricContext(tx, stationId);
      const detectionPrepared = await prepareDetection(tx, stationId, jobId, std);

      // Match the pre-refactor open/close call: HOUR increment was driven off
      // the NEW open cycle whose start = end = timestamp, so totalCycleSeconds
      // contribution per call is 0 on this path. Duration KPIs come from
      // batchDurationRollup on the 5s combined tick, not this per-cycle bump.
      await incrementHourCounts(
        tx,
        stationId,
        siteId,
        timestamp,
        1,
        Math.round(sumItemQuantities(items)),
        idealCycleIncrement,
        0,
      );

      // On-hand stock upsert — last in the tx; see completeImmediate.
      await applyProduction(tx, siteId, items);

      return {
        cycle: newCycle,
        items,
        closedEntry: transition.closedEntry,
        newStatus: transition.newStatus,
        statusChanged: transition.statusChanged,
        stationCtx,
        detectionPrepared,
        scrappedQuantity,
      };
    })
    .catch((err: unknown) => {
      if (sourceEventId && isSourceEventConflict(err)) return null;
      throw err;
    });
}

// ── Strategy: immediate replay ──────────────────────────────────

async function completeImmediateReplay(
  stationId: string,
  siteId: string,
  timestamp: Date,
  jobId: string,
  versionConnects: VersionConnects,
  sourceEventId: string | null,
  stamp: CycleStamp,
): Promise<StrategyResult | null> {
  return prisma.$transaction(async (tx) => {
    // Cross-process serialization, before the prev read — see completeImmediate.
    await acquireStationLock(tx, stationId);

    const mode = await findOpenModeLog(tx, stationId);

    const cycleRows = await tx.$queryRaw<
      Array<{
        cycle_id: string;
        cycle_start: Date;
        cycle_end: Date;
      }>
    >`
      WITH prev AS (
        SELECT "end" FROM "Cycle"
        WHERE "stationId" = ${stationId} AND "end" IS NOT NULL
        ORDER BY "end" DESC LIMIT 1
      ),
      new_cycle AS (
        INSERT INTO "Cycle" (id, start, "end", "cycleStatus", quantity, "quantityUnit", "standardCycle", "standardQuantity", "siteId", "stationId", "jobVersionId", "sourceEventId", "modeId", attrs, "createdAt", "updatedAt")
        VALUES (
          gen_random_uuid(),
          COALESCE((SELECT "end" FROM prev), ${timestamp}),
          ${timestamp},
          'GOOD',
          ${stamp.quantity},
          ${stamp.quantityUnit},
          ${stamp.standardCycle},
          ${stamp.standardQuantity},
          ${siteId},
          ${stationId},
          ${versionConnects.jobVersionId},
          ${sourceEventId}::uuid,
          ${mode?.modeId ?? null}::uuid,
          '{}',
          NOW(),
          NOW()
        )
        ON CONFLICT ("sourceEventId") DO NOTHING
        RETURNING id, start, "end"
      )
      SELECT nc.id AS cycle_id, nc.start AS cycle_start, nc."end" AS cycle_end
      FROM new_cycle nc
    `;

    const row = cycleRows[0];
    // Duplicate sourceEventId — see completeImmediate.
    if (!row) return null;
    const cycle = { id: row.cycle_id, start: row.cycle_start, end: row.cycle_end };

    // Batch M2M inserts
    if (versionConnects.toolVersions && versionConnects.toolVersions.connect.length > 0) {
      const values = Prisma.join(
        versionConnects.toolVersions.connect.map((tb) => Prisma.sql`(${cycle.id}::uuid, ${tb.id}::uuid)`),
      );
      await tx.$executeRaw`INSERT INTO "_CycleToToolVersion" ("A", "B") VALUES ${values} ON CONFLICT DO NOTHING`;
    }
    if (versionConnects.jobTools && versionConnects.jobTools.connect.length > 0) {
      const values = Prisma.join(
        versionConnects.jobTools.connect.map((jt) => Prisma.sql`(${cycle.id}::uuid, ${jt.id}::uuid)`),
      );
      await tx.$executeRaw`INSERT INTO "_CycleToJobTool" ("A", "B") VALUES ${values} ON CONFLICT DO NOTHING`;
    }

    const items = await inventory.createFromCycle(tx, cycle.id, jobId, stamp, mode?.modeId);
    const scrappedQuantity = await applyModeScrap(tx, siteId, stationId, mode, items);

    // Stock facts are never skipped: replayed cycles update on-hand too, even
    // though the replay path skips state transitions, detection, and metrics.
    await applyProduction(tx, siteId, items);

    return {
      cycle,
      items,
      closedEntry: null,
      newStatus: null,
      statusChanged: false,
      stationCtx: null,
      detectionPrepared: null,
      scrappedQuantity,
    };
  });
}

// ── Strategy: open/close replay ─────────────────────────────────

async function completeOpenCloseReplay(
  stationId: string,
  siteId: string,
  timestamp: Date,
  jobId: string,
  versionConnects: VersionConnects,
  sourceEventId: string | null,
  stamp: CycleStamp,
): Promise<StrategyResult | null> {
  return prisma
    .$transaction(async (tx) => {
      // Cross-process serialization, before ANY read — see completeImmediate.
      await acquireStationLock(tx, stationId);

      const mode = await findOpenModeLog(tx, stationId);

      const openCycles = await tx.cycle.findMany({
        where: { stationId, end: null },
        select: { id: true, start: true },
      });

      let items: CycleItems = [];

      if (openCycles.length > 0) {
        const itemArrays = await Promise.all(
          openCycles.map((oc) => inventory.createFromCycle(tx, oc.id, jobId, stamp, mode?.modeId)),
        );
        items = itemArrays.flat();

        await tx.cycle.updateMany({
          where: { stationId, end: null },
          data: { end: timestamp, ...stamp },
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
              ...stamp,
              siteId,
              stationId,
              modeId: mode?.modeId ?? null,
              ...versionConnects,
            },
          });

          items = await inventory.createFromCycle(tx, zeroCycle.id, jobId, stamp, mode?.modeId);
        }
      }

      const scrappedQuantity = await applyModeScrap(tx, siteId, stationId, mode, items);

      // Stamped on the new open cycle — see completeOpenClose.
      const newCycle = await tx.cycle.create({
        data: {
          start: timestamp,
          cycleStatus: "GOOD",
          siteId,
          stationId,
          sourceEventId,
          modeId: mode?.modeId ?? null,
          ...versionConnects,
        },
      });

      // Stock facts are never skipped on replay; see completeImmediateReplay.
      await applyProduction(tx, siteId, items);

      return {
        cycle: newCycle,
        items,
        closedEntry: null,
        newStatus: null,
        statusChanged: false,
        stationCtx: null,
        detectionPrepared: null,
        scrappedQuantity,
      };
    })
    .catch((err: unknown) => {
      if (sourceEventId && isSourceEventConflict(err)) return null;
      throw err;
    });
}

// ── Idempotency helpers ──────────────────────────────────────────

async function findBySourceEventId(
  sourceEventId: string,
): Promise<{ id: string; start: Date; end: Date | null } | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; start: Date; end: Date | null }>>`
    SELECT id, start, "end" FROM "Cycle" WHERE "sourceEventId" = ${sourceEventId}::uuid LIMIT 1
  `;
  return rows[0] ?? null;
}

function isSourceEventConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.includes("sourceEventId");
  if (typeof target === "string") return target.includes("sourceEventId");
  // No target reported: don't swallow — rethrow and let the redelivery hit
  // the sourceEventId fast path instead.
  return false;
}

// ── Types ────────────────────────────────────────────────────────

type VersionConnects = {
  jobVersionId: string;
  jobTools?: { connect: { id: string }[] };
  toolVersions?: { connect: { id: string }[] };
};
