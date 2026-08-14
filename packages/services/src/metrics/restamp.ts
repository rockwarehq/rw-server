// ── Context restamp repair service ───────────────────────────────
//
// Plant context is routinely edited late: shift schedules change, old
// assignments are deleted, downtime is reclassified. The conformed
// context columns stamped at write time (Cycle.shiftInstanceId /
// businessDate, ItemDispositionLog.shiftInstanceId / businessDate)
// then no longer reflect the schedule. restampWindow repairs them
// with set-based SQL and recalculates the affected metric buckets.
//
// Attribution rules match the write path (cycle.complete /
// getShiftForEntity) and the backfill script
// (packages/db/scripts/backfill-cycle-context.sql):
//   * Cycles are attributed at COALESCE("end", start) — completion time.
//   * Dispositions are attributed at COALESCE("occurredAt", "createdAt").
//   * Workcenter-scoped ShiftInstance wins over site-level; overlapping
//     assignments tie-break on latest rotationStartDate.
//   * businessDate = ShiftInstance.businessDate when a shift resolves,
//     else the site-timezone local calendar date of the attribution time.
//
// Unlike the backfill (which only fills missing stamps), restamp is
// UNCONDITIONAL: the schedule is the source of truth, so existing
// shiftInstanceId/businessDate values are overwritten. This includes
// ItemDispositionLog rows whose shiftInstanceId was explicitly chosen
// by a kiosk flow — there is no way to distinguish an explicit stamp
// from a schedule-resolved one, so repair overwrites both ("schedule
// is truth" semantics).
//
// jobId / logonSessionId / toolId / toolVersionId are never touched —
// they describe the run itself, not the schedule. updatedAt is left
// alone as well, matching the backfill (avoids sync churn on bulk
// repair).
//
// Updates are batched (keyset pagination on id, ≤10k rows per
// statement) so no single statement holds a pooled connection for a
// long transaction.

import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { MetricsContext } from "./context.js";
import { recalcAll } from "./recalc.js";
import { clearProcessCaches } from "./shift.js";

const BATCH_SIZE = 10_000;

// ── Types ────────────────────────────────────────────────────────

export interface RestampWindowInput {
  siteId: string;
  /** Restrict the repair to these stations (e.g. a workcenter's stations). */
  stationIds?: string[];
  /** Window start (inclusive) — compared against the attribution time. */
  from: Date;
  /** Window end (inclusive) — compared against the attribution time. */
  to: Date;
}

export interface RestampWindowResult {
  cyclesRestamped: number;
  dispositionsRestamped: number;
}

// ── SQL fragment helpers ─────────────────────────────────────────

function stationFilter(column: Prisma.Sql, stationIds?: string[]): Prisma.Sql {
  if (!stationIds || stationIds.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${column} IN (${Prisma.join(stationIds.map((id) => Prisma.sql`${id}::uuid`))})`;
}

function keysetFilter(column: Prisma.Sql, lastId: string | null): Prisma.Sql {
  if (lastId == null) return Prisma.empty;
  return Prisma.sql`AND ${column} > ${lastId}::uuid`;
}

/**
 * Postgres orders uuid by byte value; the canonical lowercase-hex text
 * form sorts identically under JS string comparison, so we can advance
 * the keyset cursor with a plain max over the returned ids.
 */
function maxId(rows: Array<{ id: string }>): string | null {
  let max: string | null = null;
  for (const row of rows) {
    if (max == null || row.id > max) max = row.id;
  }
  return max;
}

// ── Restamp batches ──────────────────────────────────────────────

/**
 * Restamp one batch of Cycle rows. Returns the updated (id, stationId)
 * pairs; an empty array means the window is exhausted.
 */
async function restampCycleBatch(
  input: RestampWindowInput,
  lastId: string | null,
): Promise<Array<{ id: string; stationId: string }>> {
  return prisma.$queryRaw<Array<{ id: string; stationId: string }>>`
    WITH batch AS (
      SELECT c.id, c."stationId", COALESCE(c."end", c.start) AS at
      FROM "Cycle" c
      WHERE c."siteId" = ${input.siteId}::uuid
        AND c."deletedAt" IS NULL
        AND COALESCE(c."end", c.start) >= ${input.from}
        AND COALESCE(c."end", c.start) <= ${input.to}
        ${stationFilter(Prisma.sql`c."stationId"`, input.stationIds)}
        ${keysetFilter(Prisma.sql`c.id`, lastId)}
      ORDER BY c.id
      LIMIT ${BATCH_SIZE}
    ),
    resolved AS (
      SELECT b.id,
             COALESCE(si_wc.id, si_site.id) AS si_id,
             COALESCE(si_wc."businessDate", si_site."businessDate",
                      (b.at AT TIME ZONE site."timezone")::date) AS bd
      FROM batch b
      JOIN "Station" s ON s.id = b."stationId"
      JOIN "Site" site ON site.id = ${input.siteId}::uuid
      LEFT JOIN LATERAL (
        SELECT si.id, si."businessDate"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."workCenterId" = s."workcenterId"
          AND si."startTime" <= b.at AND si."endTime" > b.at
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) si_wc ON TRUE
      LEFT JOIN LATERAL (
        SELECT si.id, si."businessDate"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."siteId" = ${input.siteId}::uuid AND si."workCenterId" IS NULL
          AND si."startTime" <= b.at AND si."endTime" > b.at
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) si_site ON TRUE
    )
    UPDATE "Cycle" c SET
      "shiftInstanceId" = r.si_id,
      "businessDate"    = r.bd
    FROM resolved r
    WHERE c.id = r.id
    RETURNING c.id, c."stationId"
  `;
}

/**
 * Restamp one batch of ItemDispositionLog rows. Same shift-resolution
 * logic as cycles, attributed at COALESCE(occurredAt, createdAt).
 */
async function restampDispositionBatch(
  input: RestampWindowInput,
  lastId: string | null,
): Promise<Array<{ id: string; stationId: string }>> {
  return prisma.$queryRaw<Array<{ id: string; stationId: string }>>`
    WITH batch AS (
      SELECT d.id, d."stationId", COALESCE(d."occurredAt", d."createdAt") AS at
      FROM "ItemDispositionLog" d
      WHERE d."siteId" = ${input.siteId}::uuid
        AND d."deletedAt" IS NULL
        AND COALESCE(d."occurredAt", d."createdAt") >= ${input.from}
        AND COALESCE(d."occurredAt", d."createdAt") <= ${input.to}
        ${stationFilter(Prisma.sql`d."stationId"`, input.stationIds)}
        ${keysetFilter(Prisma.sql`d.id`, lastId)}
      ORDER BY d.id
      LIMIT ${BATCH_SIZE}
    ),
    resolved AS (
      SELECT b.id,
             COALESCE(si_wc.id, si_site.id) AS si_id,
             COALESCE(si_wc."businessDate", si_site."businessDate",
                      (b.at AT TIME ZONE site."timezone")::date) AS bd
      FROM batch b
      JOIN "Station" s ON s.id = b."stationId"
      JOIN "Site" site ON site.id = ${input.siteId}::uuid
      LEFT JOIN LATERAL (
        SELECT si.id, si."businessDate"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."workCenterId" = s."workcenterId"
          AND si."startTime" <= b.at AND si."endTime" > b.at
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) si_wc ON TRUE
      LEFT JOIN LATERAL (
        SELECT si.id, si."businessDate"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."siteId" = ${input.siteId}::uuid AND si."workCenterId" IS NULL
          AND si."startTime" <= b.at AND si."endTime" > b.at
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) si_site ON TRUE
    )
    UPDATE "ItemDispositionLog" d SET
      "shiftInstanceId" = r.si_id,
      "businessDate"    = r.bd
    FROM resolved r
    WHERE d.id = r.id
    RETURNING d.id, d."stationId"
  `;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Repair conformed context stamps for a site + time window, then
 * recalculate the affected metric buckets.
 *
 * 1. Cycles with COALESCE("end", start) in [from, to] get their
 *    shiftInstanceId + businessDate re-resolved from the current
 *    ShiftInstance schedule (unconditional overwrite).
 * 2. ItemDispositionLog rows with COALESCE(occurredAt, createdAt) in
 *    [from, to] get the same treatment.
 * 3. recalcAll (full count + duration recompute, with rollup cascade
 *    to SHIFT/DAY/WORKCENTER/SITE and JOB buckets) runs for every
 *    station that had rows restamped.
 *
 * Batched keyset updates — safe over PlanetScale pooled connections;
 * no single statement touches more than 10k rows.
 */
export async function restampWindow(input: RestampWindowInput): Promise<RestampWindowResult> {
  const affectedStations = new Set<string>();
  let cyclesRestamped = 0;
  let dispositionsRestamped = 0;

  // ── 1. Restamp cycles ─────────────────────────────────────────
  let cursor: string | null = null;
  for (;;) {
    const rows = await restampCycleBatch(input, cursor);
    if (rows.length === 0) break;
    cyclesRestamped += rows.length;
    for (const row of rows) affectedStations.add(row.stationId);
    cursor = maxId(rows);
    if (rows.length < BATCH_SIZE) break;
  }

  // ── 2. Restamp dispositions ───────────────────────────────────
  cursor = null;
  for (;;) {
    const rows = await restampDispositionBatch(input, cursor);
    if (rows.length === 0) break;
    dispositionsRestamped += rows.length;
    for (const row of rows) affectedStations.add(row.stationId);
    cursor = maxId(rows);
    if (rows.length < BATCH_SIZE) break;
  }

  // ── 3. Recalculate affected buckets ───────────────────────────
  // The process-level shift TTL cache may still hold the pre-edit
  // schedule (30s TTL); clear it so recalc resolves fresh windows.
  if (affectedStations.size > 0) {
    clearProcessCaches();
    const ctx = new MetricsContext();
    for (const stationId of affectedStations) {
      try {
        await recalcAll(stationId, input.siteId, input.from, input.to, ctx);
      } catch (err) {
        console.error(`[metrics:restamp] Failed to recalc buckets for station ${stationId}:`, err);
      }
    }
  }

  return { cyclesRestamped, dispositionsRestamped };
}

// ── Schedule-change wiring helper ────────────────────────────────

export interface ScheduleChangeRestampInput {
  siteId: string;
  /** Scope of the changed assignment — null/undefined means site-level. */
  workCenterId?: string | null;
  /** Earliest time the schedule change can affect (e.g. rotationStartDate). */
  from: Date;
  /** Defaults to now — future rows don't exist yet. */
  to?: Date;
}

/**
 * Repair stamps after a shift schedule change (ShiftAssignment
 * create / update / delete) commits.
 *
 * Resolves the affected stations (all stations of the assignment's
 * workcenter, or the whole site for a site-level assignment) and runs
 * restampWindow from the schedule change's effective start to now.
 *
 * Call fire-and-forget with error logging after the schedule mutation
 * commits, e.g.:
 *
 *   restampAfterScheduleChange({ siteId, workCenterId, from: rotationStartDate })
 *     .catch((err) => console.error("[shift] restamp failed:", err));
 */
export async function restampAfterScheduleChange(input: ScheduleChangeRestampInput): Promise<RestampWindowResult> {
  const to = input.to ?? new Date();
  if (to.getTime() <= input.from.getTime()) {
    return { cyclesRestamped: 0, dispositionsRestamped: 0 };
  }

  let stationIds: string[] | undefined;
  if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { workcenterId: input.workCenterId },
      select: { id: true },
    });
    stationIds = stations.map((s) => s.id);
    if (stationIds.length === 0) {
      return { cyclesRestamped: 0, dispositionsRestamped: 0 };
    }
  }

  return restampWindow({ siteId: input.siteId, stationIds, from: input.from, to });
}
