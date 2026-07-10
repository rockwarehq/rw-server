import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { publishMetricValueChange } from "../../rpc/metrics-bus.js";
import { updateTimeBased } from "../../metrics/recalc.js";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";

type TransactionClient = Prisma.TransactionClient;

// ── Types ────────────────────────────────────────────────────────

/** Open state-log row snapshot handed to {@link applyCycleCompleteTransition}. */
export interface CycleTransitionOpenRow {
  id: string;
  startTime: Date;
  state: "UP" | "DOWN";
  status: "FAST" | "SLOW" | "UP" | "DOWN" | null;
  statusReasonId: string | null;
  blockId: string;
}

export interface CycleCompleteTransitionResult {
  /** Open status after the cycle: RUNNING ("UP") or "SLOW". */
  newStatus: "UP" | "SLOW";
  /** A row was opened/closed/converted with a different resulting status. */
  statusChanged: boolean;
  /** Populated only when a row actually closed. */
  closedEntry: ClosedEntryInfo | null;
}

/**
 * Info about the state entry that was closed during a transition.
 * Returned to callers so they can trigger metric updates for the
 * closed entry's full time range (which may span multiple hours).
 */
export interface ClosedEntryInfo {
  /** Start of the closed entry. */
  startTime: Date;
  /** End of the closed entry (the transition timestamp). */
  endTime: Date;
  /** The state of the closed entry (UP or DOWN). */
  state: "UP" | "DOWN";
  /** Closed entry's status, for change detection. */
  status?: "FAST" | "SLOW" | "UP" | "DOWN" | null;
  /** Closed entry's statusReasonId, for change detection. */
  statusReasonId?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Acquire a transaction-scoped advisory lock for a station.
 *
 * Serializes all state transitions (UP, SLOW, DOWN) for the same
 * station so that concurrent transitions (e.g. a slow timer firing
 * while a cycle completes) don't create overlapping state log entries.
 *
 * Uses pg_advisory_xact_lock which is automatically released when the
 * transaction commits or rolls back — no manual cleanup needed.
 */
export async function acquireStationLock(client: TransactionClient | typeof prisma, stationId: string) {
  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${stationId}))::text`;
}

/**
 * Find the current (open) state log entry for a station.
 * An open entry has endTime = null.
 */
export async function findOpenStateEntry(client: TransactionClient | typeof prisma, stationId: string) {
  return client.stationStateLog.findFirst({
    where: { stationId, endTime: null, deletedAt: null },
    orderBy: { startTime: "desc" },
  });
}

/**
 * Close ALL open state log entries for a station by setting their endTime.
 *
 * Uses updateMany instead of update-by-id to defensively clean up any
 * orphaned open entries that may have leaked from past race conditions.
 */
async function closeOpenStateEntries(client: TransactionClient | typeof prisma, stationId: string, endTime: Date) {
  return client.stationStateLog.updateMany({
    where: { stationId, endTime: null, deletedAt: null },
    data: { endTime },
  });
}

/**
 * Create a new state log entry.
 */
async function createStateEntry(
  client: TransactionClient | typeof prisma,
  data: {
    stationId: string;
    startTime: Date;
    state: "UP" | "DOWN";
    status: "FAST" | "SLOW" | "UP" | "DOWN";
    blockId: string;
    jobVersionId?: string | null;
  },
) {
  return client.stationStateLog.create({
    data: {
      stationId: data.stationId,
      startTime: data.startTime,
      state: data.state,
      status: data.status,
      blockId: data.blockId,
      jobVersionId: data.jobVersionId ?? null,
    },
  });
}

/**
 * Look up the siteId for a station. Used by transitionToDown
 * to fire updateTimeBased after the transaction.
 */
async function getStationSiteId(stationId: string): Promise<string | null> {
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { siteId: true },
  });
  return station?.siteId ?? null;
}

/**
 * Snapshot of the station fields needed to publish live metric events.
 * Returned from {@link loadStationMetricContext}; consumed by the
 * `publishStation*MetricEvent` family. Allows the underlying DB read
 * to share a connection (e.g. the cycle-complete transaction) instead
 * of each publish helper checking out its own.
 */
export interface StationMetricContext {
  stationId: string;
  siteId: string;
  workspaceId: string;
  name: string;
  path: string;
}

/**
 * Load the station-side context (siteId, name, hierarchical path) used
 * by every live publishStation* event. Accepts a transaction client so
 * the DB reads can ride inside an existing transaction.
 */
export async function loadStationMetricContext(
  client: TransactionClient | typeof prisma,
  stationId: string,
): Promise<StationMetricContext | null> {
  const stationRows = await client.$queryRaw<
    Array<{ siteId: string; workspaceId: string; name: string; workcenterId: string | null }>
  >`
    SELECT s."siteId"::text, si."workspaceId"::text AS "workspaceId", s.name, s."workcenterId"::text
    FROM "Station" s JOIN "Site" si ON si.id = s."siteId"
    WHERE s.id = ${stationId}::uuid
  `;
  const station = stationRows[0];
  if (!station) return null;

  const sitePath = `site.${station.siteId}`;
  let path: string;
  if (!station.workcenterId) {
    path = `${sitePath}.station.${stationId}`;
  } else {
    const chainRows = await client.$queryRaw<Array<{ id: string; depth: number }>>`
      WITH RECURSIVE chain AS (
        SELECT id, "parentId", 0 AS depth FROM "Workcenter" WHERE id = ${station.workcenterId}::uuid
        UNION ALL
        SELECT w.id, w."parentId", c.depth + 1
        FROM "Workcenter" w JOIN chain c ON w.id = c."parentId"
      )
      SELECT id::text, depth FROM chain ORDER BY depth DESC
    `;
    const wcSegments = chainRows.map((r) => `workcenter.${r.id}`).join(".");
    path = `${sitePath}.${wcSegments}.station.${stationId}`;
  }

  return { stationId, siteId: station.siteId, workspaceId: station.workspaceId, name: station.name, path };
}

/** Publish entity.changes so livestore re-resolves status-bound properties. Only after a real change, post-commit. */
export function publishStationStatusEntityEvent(ctx: StationMetricContext, changedFields: string[]): void {
  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Station,
    entityId: ctx.stationId,
    siteId: ctx.siteId,
    workspaceId: ctx.workspaceId,
    changedFields,
  });
}

function publishStationStatusMetricEvent(
  ctx: StationMetricContext,
  status: "FAST" | "SLOW" | "UP" | "DOWN",
  observedAt: Date,
): void {
  publishMetricValueChange({
    siteId: ctx.siteId,
    entityType: "STATION",
    entityId: ctx.stationId,
    metricKey: "status",
    sourceType: "live",
    value: status,
    observedAt,
    entityName: ctx.name,
    path: ctx.path,
  });
}

async function publishStationStatusMetric(
  stationId: string,
  status: "FAST" | "SLOW" | "UP" | "DOWN",
  observedAt: Date,
): Promise<void> {
  const ctx = await loadStationMetricContext(prisma, stationId);
  if (!ctx) return;
  publishStationStatusMetricEvent(ctx, status, observedAt);
}

function publishStationStatusReasonMetricEvent(
  ctx: StationMetricContext,
  statusReasonId: string | null,
  observedAt: Date,
): void {
  publishMetricValueChange({
    siteId: ctx.siteId,
    entityType: "STATION",
    entityId: ctx.stationId,
    metricKey: "statusReason",
    sourceType: "live",
    value: statusReasonId,
    observedAt,
    entityName: ctx.name,
    path: ctx.path,
  });
}

async function publishStationStatusReasonMetric(
  stationId: string,
  statusReasonId: string | null,
  observedAt: Date,
): Promise<void> {
  const ctx = await loadStationMetricContext(prisma, stationId);
  if (!ctx) return;
  publishStationStatusReasonMetricEvent(ctx, statusReasonId, observedAt);
}

function publishStationCurrentJobMetricEvent(
  ctx: StationMetricContext,
  jobName: string | null,
  observedAt: Date,
): void {
  publishMetricValueChange({
    siteId: ctx.siteId,
    entityType: "STATION",
    entityId: ctx.stationId,
    metricKey: "currentJob",
    sourceType: "live",
    value: jobName,
    observedAt,
    entityName: ctx.name,
    path: ctx.path,
  });
}

async function publishStationCurrentJobMetric(
  stationId: string,
  jobName: string | null,
  observedAt: Date,
): Promise<void> {
  const ctx = await loadStationMetricContext(prisma, stationId);
  if (!ctx) return;
  publishStationCurrentJobMetricEvent(ctx, jobName, observedAt);
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function publishStationLastCycleMetricEvent(
  ctx: StationMetricContext,
  cycleSeconds: number | null,
  observedAt: Date,
): void {
  publishMetricValueChange({
    siteId: ctx.siteId,
    entityType: "STATION",
    entityId: ctx.stationId,
    metricKey: "lastCycleSeconds",
    sourceType: "live",
    value: cycleSeconds == null ? null : roundToTenth(cycleSeconds),
    observedAt,
    entityName: ctx.name,
    path: ctx.path,
  });
}

async function publishStationLastCycleMetric(
  stationId: string,
  cycleSeconds: number | null,
  observedAt: Date,
): Promise<void> {
  const ctx = await loadStationMetricContext(prisma, stationId);
  if (!ctx) return;
  publishStationLastCycleMetricEvent(ctx, cycleSeconds, observedAt);
}

function publishStationStandardCycleMetricEvent(
  ctx: StationMetricContext,
  standardCycleSeconds: number | null,
  observedAt: Date,
): void {
  publishMetricValueChange({
    siteId: ctx.siteId,
    entityType: "STATION",
    entityId: ctx.stationId,
    metricKey: "standardCycleSeconds",
    sourceType: "live",
    value: standardCycleSeconds == null ? null : roundToTenth(standardCycleSeconds),
    observedAt,
    entityName: ctx.name,
    path: ctx.path,
  });
}

async function publishStationStandardCycleMetric(
  stationId: string,
  standardCycleSeconds: number | null,
  observedAt: Date,
): Promise<void> {
  const ctx = await loadStationMetricContext(prisma, stationId);
  if (!ctx) return;
  publishStationStandardCycleMetricEvent(ctx, standardCycleSeconds, observedAt);
}

export function publishCurrentShiftMetric(
  entityType: "STATION" | "WORKCENTER",
  entityId: string,
  siteId: string,
  entityName: string,
  path: string,
  shiftName: string | null,
  shiftInstanceId: string | null,
  observedAt: Date,
): void {
  publishMetricValueChange({
    siteId,
    entityType,
    entityId,
    metricKey: "currentShift",
    sourceType: "live",
    value: shiftName,
    observedAt,
    entityName,
    path,
  });
  publishMetricValueChange({
    siteId,
    entityType,
    entityId,
    metricKey: "currentShiftInstanceId",
    sourceType: "live",
    value: shiftInstanceId,
    observedAt,
    entityName,
    path,
  });
}

/** Minimum minutes each side of a split must retain. */
const SPLIT_MIN_MARGIN_MINUTES = 5;

// ── Public API ───────────────────────────────────────────────────

/** Latest completed cycle end, clamped into [floor, ceil]; floor when no cycles exist. */
async function lastCycleEndClamped(
  client: TransactionClient | typeof prisma,
  stationId: string,
  floor: Date,
  ceil: Date,
): Promise<Date> {
  const rows = await client.$queryRaw<Array<{ end: Date }>>`
    SELECT "end" FROM "Cycle"
    WHERE "stationId" = ${stationId} AND "end" IS NOT NULL
    ORDER BY "end" DESC LIMIT 1
  `;
  const lastEnd = rows[0]?.end ?? floor;
  return new Date(Math.min(Math.max(lastEnd.getTime(), floor.getTime()), ceil.getTime()));
}

/**
 * Apply a cycle completion to the state log under the period model:
 * rows are status periods, so most cycles touch nothing.
 *
 * - RUNNING + on-pace cycle, or SLOW + slow cycle → no writes (SLOW is
 *   sticky until a non-slow cycle completes, so dashboards don't flap).
 * - SLOW + on-pace cycle → close SLOW, open RUNNING (same block).
 * - DOWN → close DOWN, open RUNNING (new block) — always RUNNING: a
 *   recovery cycle spans the down period, so its duration never means SLOW.
 * - RUNNING + slow cycle → fallback when the slow timer didn't fire;
 *   SLOW backdates to the start of the overlong cycle.
 *
 * Caller must already hold the station advisory lock in `tx`.
 */
export async function applyCycleCompleteTransition(
  tx: TransactionClient,
  stationId: string,
  timestamp: Date,
  opts: {
    cycleWasSlow: boolean;
    /** Start of the completed cycle (== previous cycle's end); backdates the SLOW fallback. */
    cycleStart: Date;
    jobVersionId?: string | null;
    openRow: CycleTransitionOpenRow | null;
  },
): Promise<CycleCompleteTransitionResult> {
  const { openRow } = opts;

  const openRunning = async (blockId: string) => {
    await createStateEntry(tx, {
      stationId,
      startTime: timestamp,
      state: "UP",
      status: "UP",
      blockId,
      jobVersionId: opts.jobVersionId,
    });
  };

  if (!openRow) {
    await openRunning(randomUUID());
    return { newStatus: "UP", statusChanged: true, closedEntry: null };
  }

  const closed = (endTime: Date): ClosedEntryInfo => ({
    startTime: openRow.startTime,
    endTime,
    state: openRow.state,
    status: openRow.status,
    statusReasonId: openRow.statusReasonId,
  });

  if (openRow.state === "DOWN") {
    await closeOpenStateEntries(tx, stationId, timestamp);
    await openRunning(randomUUID());
    return { newStatus: "UP", statusChanged: true, closedEntry: closed(timestamp) };
  }

  const running = openRow.status !== "SLOW"; // FAST/null on an UP row counts as RUNNING

  if (running === !opts.cycleWasSlow) {
    // Status already matches the cycle outcome — the hot path writes nothing.
    return { newStatus: running ? "UP" : "SLOW", statusChanged: false, closedEntry: null };
  }

  if (!running) {
    // SLOW + on-pace cycle → back to RUNNING, same block (state stayed UP).
    await closeOpenStateEntries(tx, stationId, timestamp);
    await openRunning(openRow.blockId);
    return { newStatus: "UP", statusChanged: true, closedEntry: closed(timestamp) };
  }

  // RUNNING + slow cycle. Backdate SLOW to the overlong cycle's start;
  // convert in place when the row opened there (no zero-duration rows).
  const slowStart = new Date(
    Math.min(Math.max(opts.cycleStart.getTime(), openRow.startTime.getTime()), timestamp.getTime()),
  );
  if (openRow.startTime >= slowStart) {
    await tx.stationStateLog.update({ where: { id: openRow.id }, data: { status: "SLOW" } });
    return { newStatus: "SLOW", statusChanged: true, closedEntry: null };
  }
  await closeOpenStateEntries(tx, stationId, slowStart);
  await createStateEntry(tx, {
    stationId,
    startTime: slowStart,
    state: "UP",
    status: "SLOW",
    blockId: openRow.blockId,
    jobVersionId: opts.jobVersionId,
  });
  return { newStatus: "SLOW", statusChanged: true, closedEntry: closed(slowStart) };
}

/**
 * Split the open state entry at a job change so entries stay
 * job-homogeneous: close the open row and continue it with the same
 * state/status/blockId/statusReasonId under the new job version. Caller
 * must hold the station advisory lock in `tx`.
 */
export async function splitOpenStateEntryForJobChange(
  tx: TransactionClient,
  stationId: string,
  timestamp: Date,
  newJobVersionId: string | null,
): Promise<void> {
  const current = await findOpenStateEntry(tx, stationId);
  if (!current || current.jobVersionId === newJobVersionId) return;

  if (current.startTime >= timestamp) {
    await tx.stationStateLog.update({ where: { id: current.id }, data: { jobVersionId: newJobVersionId } });
    return;
  }

  await closeOpenStateEntries(tx, stationId, timestamp);
  await tx.stationStateLog.create({
    data: {
      stationId,
      startTime: timestamp,
      state: current.state,
      status: current.status,
      blockId: current.blockId,
      statusReasonId: current.statusReasonId,
      jobVersionId: newJobVersionId,
    },
  });
}

/**
 * Transition a station to the SLOW sub-status.
 *
 * Called by the slow detection timer. The machine is still UP but the
 * in-progress cycle exceeded the expected cycle time, so SLOW backdates
 * to the last cycle completion (the overlong cycle's start). A young
 * open entry (opened at that cycle) flips in place; a long-lived
 * RUNNING entry is closed there and continued as SLOW (same block).
 *
 * No-op if the station is already DOWN or SLOW.
 *
 * No metric bucket update is needed: SLOW is still UP state,
 * so duration KPIs (runSeconds) don't change.
 */
export async function transitionToSlow(stationId: string, timestamp: Date) {
  const { entry, statusChanged } = await prisma.$transaction(async (tx) => {
    // Serialize with other state transitions for this station
    await acquireStationLock(tx, stationId);

    const current = await findOpenStateEntry(tx, stationId);

    if (!current) {
      // No open entry — create a SLOW one (shouldn't normally happen)
      const blockId = randomUUID();
      const created = await createStateEntry(tx, {
        stationId,
        startTime: timestamp,
        state: "UP",
        status: "SLOW",
        blockId,
      });
      return { entry: created, statusChanged: true };
    }

    // Already DOWN — downtime supersedes slow, do nothing
    if (current.state === "DOWN") {
      return { entry: current, statusChanged: false };
    }

    // Already SLOW — no change needed
    if (current.status === "SLOW") {
      return { entry: current, statusChanged: false };
    }

    // Currently RUNNING — backdate SLOW to the last cycle completion.
    const slowStart = await lastCycleEndClamped(tx, stationId, current.startTime, timestamp);
    if (current.startTime >= slowStart) {
      const updated = await tx.stationStateLog.update({
        where: { id: current.id },
        data: { status: "SLOW" },
      });
      return { entry: updated, statusChanged: true };
    }
    await closeOpenStateEntries(tx, stationId, slowStart);
    const created = await tx.stationStateLog.create({
      data: {
        stationId,
        startTime: slowStart,
        state: "UP",
        status: "SLOW",
        blockId: current.blockId,
        jobVersionId: current.jobVersionId,
      },
    });
    return { entry: created, statusChanged: true };
  });

  const ctx = await loadStationMetricContext(prisma, stationId);
  if (ctx) {
    publishStationStatusMetricEvent(
      ctx,
      (entry.status ?? entry.state) as "FAST" | "SLOW" | "UP" | "DOWN",
      entry.updatedAt,
    );
    if (statusChanged) publishStationStatusEntityEvent(ctx, ["status", "statusStartAt"]);
  }
  return entry;
}

/**
 * Transition a station to DOWN state.
 *
 * Called by the downtime detection timer. Downtime backdates to the
 * last cycle completion: a SLOW entry already starts there (SLOW
 * backdates too) and converts in place — absorbing the slow period —
 * while a long-lived RUNNING entry is closed there and continued as
 * DOWN so run time isn't reclassified. DOWN always starts a new block.
 *
 * After the transaction, fires updateTimeBased to recompute
 * duration KPIs for the range that flipped to DOWN.
 */
export async function transitionToDown(stationId: string, timestamp: Date) {
  const result = await prisma.$transaction(async (tx) => {
    // Serialize with other state transitions for this station
    await acquireStationLock(tx, stationId);

    const current = await findOpenStateEntry(tx, stationId);

    // Look up the active job for this station (open StationJobLog entry)
    const activeJob = await tx.stationJobLog.findFirst({
      where: { stationId, endTime: null },
      select: { jobVersionId: true },
      orderBy: { startTime: "desc" },
    });
    const jobVersionId = activeJob?.jobVersionId ?? null;

    if (!current) {
      // No open entry — create a DOWN one
      const blockId = randomUUID();
      const entry = await createStateEntry(tx, {
        stationId,
        startTime: timestamp,
        state: "DOWN",
        status: "DOWN",
        blockId,
        jobVersionId,
      });
      return { entry, convertedRange: null as { startTime: Date; endTime: Date } | null, statusChanged: true };
    }

    // Already DOWN — no change needed
    if (current.state === "DOWN") {
      return {
        entry: current,
        convertedRange: null as { startTime: Date; endTime: Date } | null,
        statusChanged: false,
      };
    }

    // State change UP → DOWN — DOWN starts at the last cycle time,
    // not the timer fire time.
    const downStart = await lastCycleEndClamped(tx, stationId, current.startTime, timestamp);
    const blockId = randomUUID();

    let entry: Awaited<ReturnType<typeof createStateEntry>>;
    if (current.startTime >= downStart) {
      // Young entry (opened at that cycle, or a backdated SLOW) — convert in place.
      // Defensive: close any orphaned open entries (not the one we're converting)
      await tx.stationStateLog.updateMany({
        where: { stationId, endTime: null, deletedAt: null, id: { not: current.id } },
        data: { endTime: timestamp },
      });
      entry = await tx.stationStateLog.update({
        where: { id: current.id },
        data: { state: "DOWN", status: "DOWN", blockId, jobVersionId },
      });
    } else {
      // Long-lived RUNNING entry — close it at the last cycle and continue as DOWN.
      await closeOpenStateEntries(tx, stationId, downStart);
      entry = await tx.stationStateLog.create({
        data: { stationId, startTime: downStart, state: "DOWN", status: "DOWN", blockId, jobVersionId },
      });
    }

    // Range that changed from UP→DOWN, needed for metrics recalc
    const convertedRange = { startTime: downStart, endTime: timestamp };
    return { entry, convertedRange, statusChanged: true };
  });

  // Fire updateTimeBased for the converted range (after transaction commits)
  if (result.convertedRange) {
    const siteId = await getStationSiteId(stationId);
    if (siteId) {
      updateTimeBased(stationId, siteId, result.convertedRange.startTime, result.convertedRange.endTime).catch(
        (err) => {
          console.error(`[state] Failed to update time-based metrics for station ${stationId}:`, err);
        },
      );
    }
  }

  const ctx = await loadStationMetricContext(prisma, stationId);
  if (ctx) {
    publishStationStatusMetricEvent(
      ctx,
      (result.entry.status ?? result.entry.state) as "FAST" | "SLOW" | "UP" | "DOWN",
      result.entry.updatedAt,
    );
    publishStationStatusReasonMetricEvent(ctx, result.entry.statusReasonId, result.entry.updatedAt);
    if (result.statusChanged) publishStationStatusEntityEvent(ctx, ["status", "statusReasonId", "statusStartAt"]);
  }
  return result.entry;
}

export {
  publishStationStatusMetric,
  publishStationStatusReasonMetric,
  publishStationCurrentJobMetric,
  publishStationLastCycleMetric,
  publishStationStandardCycleMetric,
  publishStationStatusMetricEvent,
  publishStationStatusReasonMetricEvent,
  publishStationCurrentJobMetricEvent,
  publishStationLastCycleMetricEvent,
  publishStationStandardCycleMetricEvent,
};

// ── Split ────────────────────────────────────────────────────────

type SplitDownEntryResult =
  | {
      success: true;
      entries: [
        first: Awaited<ReturnType<typeof prisma.stationStateLog.update>>,
        second: Awaited<ReturnType<typeof prisma.stationStateLog.create>>,
      ];
    }
  | { error: string; code: "NOT_FOUND" | "INVALID_STATE" | "SPLIT_TOO_CLOSE_TO_START" | "SPLIT_TOO_CLOSE_TO_END" };

/**
 * Split a DOWN state log entry into two consecutive entries at a
 * given duration (in minutes) from the entry's startTime.
 *
 * Both resulting entries inherit the original's state, status,
 * blockId, and statusReasonId. The first entry runs from the
 * original startTime to the split point; the second runs from the
 * split point to the original endTime (or remains open if the
 * original had no endTime).
 *
 * Constraints:
 * - The entry must have state = DOWN.
 * - The split point must be at least 5 minutes from the start.
 * - The split point must be at least 5 minutes from the end
 *   (using the current time as the effective end for open entries).
 */
export async function splitDownEntry(entryId: string, splitAt: Date): Promise<SplitDownEntryResult> {
  return prisma.$transaction(async (tx) => {
    // Look up the entry
    const entry = await tx.stationStateLog.findFirst({
      where: { id: entryId, deletedAt: null },
    });

    if (!entry) {
      return { error: "State log entry not found", code: "NOT_FOUND" as const };
    }

    // Must be a DOWN entry
    if (entry.state !== "DOWN") {
      return { error: "Only DOWN entries can be split", code: "INVALID_STATE" as const };
    }

    // Serialize with other state transitions for this station
    await acquireStationLock(tx, entry.stationId);

    // Determine effective end (now for open entries)
    const effectiveEnd = entry.endTime ?? new Date();

    // Validate: split point must be >= 5 min from start
    const minStart = new Date(entry.startTime.getTime() + SPLIT_MIN_MARGIN_MINUTES * 60_000);
    if (splitAt < minStart) {
      return {
        error: `Split point must be at least ${SPLIT_MIN_MARGIN_MINUTES} minutes from the start of the entry`,
        code: "SPLIT_TOO_CLOSE_TO_START" as const,
      };
    }

    // Validate: split point must be >= 5 min from the effective end
    const maxEnd = new Date(effectiveEnd.getTime() - SPLIT_MIN_MARGIN_MINUTES * 60_000);
    if (splitAt > maxEnd) {
      return {
        error: `Split point must be at least ${SPLIT_MIN_MARGIN_MINUTES} minutes from the end of the entry`,
        code: "SPLIT_TOO_CLOSE_TO_END" as const,
      };
    }

    // Update the original entry: truncate its endTime to the split point
    const first = await tx.stationStateLog.update({
      where: { id: entry.id },
      data: { endTime: splitAt },
    });

    // Create the second entry: from the split point to the original endTime
    const second = await tx.stationStateLog.create({
      data: {
        stationId: entry.stationId,
        startTime: splitAt,
        endTime: entry.endTime, // null stays null for open entries
        state: entry.state,
        status: entry.status,
        blockId: entry.blockId,
        statusReasonId: entry.statusReasonId,
        jobVersionId: entry.jobVersionId,
      },
    });

    return { success: true as const, entries: [first, second] };
  });
}

// ── Assign downtime reason ───────────────────────────────────────

type AssignDowntimeReasonResult =
  | { success: true; updatedCount: number }
  | { error: string; code: "NOT_FOUND" | "INVALID_STATE" | "REASON_NOT_FOUND" };

/**
 * Assign (or clear) a StatusReason on a DOWN state log entry.
 *
 * When `applyToBlock` is true (default), the reason is applied to
 * **all** entries sharing the same blockId — i.e. the entire
 * contiguous downtime period (including entries created by splits).
 *
 * After the update, triggers a metric recalculation for the
 * affected time range so that plannedDownSeconds / unplannedDownSeconds
 * are immediately recomputed.
 *
 * Pass `statusReasonId = null` to clear the reason (reclassifies
 * the downtime as unplanned).
 */
export async function assignDowntimeReason(
  entryId: string,
  statusReasonId: string | null,
  options?: { applyToBlock?: boolean },
): Promise<AssignDowntimeReasonResult> {
  const applyToBlock = options?.applyToBlock ?? true;

  // Look up the target entry
  const entry = await prisma.stationStateLog.findFirst({
    where: { id: entryId, deletedAt: null },
    include: { station: { select: { siteId: true, site: { select: { workspaceId: true } } } } },
  });

  if (!entry) {
    return { error: "State log entry not found", code: "NOT_FOUND" };
  }

  if (entry.state !== "DOWN") {
    return { error: "Only DOWN entries can have a downtime reason", code: "INVALID_STATE" };
  }

  // Validate the reason exists (when assigning, not clearing)
  if (statusReasonId != null) {
    const reason = await prisma.statusReason.findUnique({
      where: { id: statusReasonId },
      select: { id: true },
    });
    if (!reason) {
      return { error: "Status reason not found", code: "REASON_NOT_FOUND" };
    }
  }

  // Update the entry (or all entries in the block)
  const where = applyToBlock
    ? { blockId: entry.blockId, state: "DOWN" as const, deletedAt: null }
    : { id: entryId, deletedAt: null };

  const result = await prisma.stationStateLog.updateMany({
    where,
    data: { statusReasonId },
  });

  // Determine the affected time range across all entries in the block.
  // For single-entry updates, the range is just that entry.
  // For block-level updates, query the block's full span.
  let rangeStart = entry.startTime;
  let rangeEnd = entry.endTime ?? new Date();

  if (applyToBlock) {
    const blockEntries = await prisma.stationStateLog.findMany({
      where: { blockId: entry.blockId, state: "DOWN", deletedAt: null },
      select: { startTime: true, endTime: true },
      orderBy: { startTime: "asc" },
    });
    if (blockEntries.length > 0) {
      rangeStart = blockEntries[0].startTime;
      const last = blockEntries[blockEntries.length - 1];
      rangeEnd = last.endTime ?? new Date();
    }
  }

  // Fire metric recalculation in the background. The client handles
  // stale metrics via delayed re-invalidation — we must not block the
  // response because large blocks (multi-day downtime) touch hundreds
  // of buckets and would timeout the HTTP request.
  const siteId = entry.station.siteId;
  console.log(
    `[assignDowntimeReason] station=${entry.stationId} reason=${statusReasonId} range=${rangeStart.toISOString()}..${rangeEnd.toISOString()} updatedCount=${result.count}`,
  );
  updateTimeBased(entry.stationId, siteId, rangeStart, rangeEnd).then(
    () => console.log(`[assignDowntimeReason] updateTimeBased completed`),
    (err) => console.error(`[assignDowntimeReason] updateTimeBased FAILED for station ${entry.stationId}:`, err),
  );

  // Publish statusReason live metric only if the open row was part of the update.
  const openAffected = applyToBlock
    ? (await prisma.stationStateLog.count({
        where: { stationId: entry.stationId, blockId: entry.blockId, endTime: null, deletedAt: null },
      })) > 0
    : entry.endTime === null;

  if (openAffected) {
    publishStationStatusReasonMetric(entry.stationId, statusReasonId, new Date()).catch((err) => {
      console.error(
        `[assignDowntimeReason] publishStationStatusReasonMetric failed for station ${entry.stationId}:`,
        err,
      );
    });
    // ["statusReasonId"] also matches the statusReason path via the resolver's `${path}Id` rule.
    publishEntityEvent({
      action: "updated",
      entityKey: SYSTEM_ENTITY_KEYS.Station,
      entityId: entry.stationId,
      siteId: entry.station.siteId,
      workspaceId: entry.station.site.workspaceId,
      changedFields: ["statusReasonId"],
    });
  }

  return { success: true, updatedCount: result.count };
}

// ── List state logs ──────────────────────────────────────────────

export interface ListStateLogsFilter {
  stationId: string;
  startTime?: Date;
  endTime?: Date;
  state?: "UP" | "DOWN";
  limit?: number;
  offset?: number;
}

/**
 * List state log entries for a station with optional filtering.
 *
 * Supports time-range overlap queries: returns entries whose
 * [startTime, endTime] interval intersects the given range.
 * Open entries (endTime = null) are treated as still ongoing.
 */
export async function listStateLogs(filter: ListStateLogsFilter) {
  const { stationId, startTime, endTime, state, limit = 100, offset = 0 } = filter;

  const where: Record<string, unknown> = {
    stationId,
    deletedAt: null,
  };

  if (state) {
    where.state = state;
  }

  if (startTime || endTime) {
    if (startTime) {
      // Entry must end after startTime (or still be open)
      where.OR = [{ endTime: { gte: startTime } }, { endTime: null }];
    }
    if (endTime) {
      where.startTime = { lte: endTime };
    }
  }

  const [logs, total] = await Promise.all([
    prisma.stationStateLog.findMany({
      where,
      include: {
        statusReason: {
          select: {
            id: true,
            name: true,
            isPlannedDown: true,
            category: { select: { id: true, name: true } },
          },
        },
        jobVersion: {
          select: { id: true, name: true },
        },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { startTime: "desc" },
    }),
    prisma.stationStateLog.count({ where }),
  ]);

  return {
    data: logs,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}
