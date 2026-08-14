// ── Metric bucket scaffolding ────────────────────────────────────
// Ensures empty STATION-family HOUR rows exist so that time periods
// with zero activity still appear in queries: per hour a RESIDUAL row
// (jobId NULL, plain station path) plus a per-job row for each job
// currently open on the station (open StationJobLog window). SHIFT/DAY
// and WORKCENTER/SITE rows are never persisted — they are derived at
// read time — so no other scaffolding exists.
//
// KPI population is handled by the base writer (cascade.ts) and
// recalc.ts — this module only creates empty rows.

import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import {
  getShiftForEntity,
  getHourBucketsForEntity,
  resolveHourBucketForEntity,
  getLocalMidnightUTC,
  getTimezoneOffsetMs,
} from "./shift.js";
import { scheduleNextShiftBuckets } from "../queues/metric-buckets.js";
import { scheduleHourClose } from "../queues/hour-close.js";
import { onBucketsChanged, ZERO_SNAPSHOT, type BucketChange } from "./sync.js";
import { resolveEntityPath, resolveEntityName } from "./hierarchy.js";
import { MetricsContext } from "./context.js";
import { TtlCache } from "./ttl-cache.js";

// ── Process-level timezone cache ─────────────────────────────────
// Timezones effectively never change at runtime, so a long TTL is safe.
const processTzCache = new TtlCache<string>({ ttlMs: 300_000, maxSize: 100 });

// ── Site timezone lookup ─────────────────────────────────────────

/**
 * Fetch the IANA timezone for a site. Falls back to "UTC" if the
 * site is not found (shouldn't happen in practice).
 */
export async function getSiteTimezone(siteId: string, ctx?: MetricsContext): Promise<string> {
  // Layer 1: per-pipeline cache
  if (ctx) {
    const cached = ctx.getTimezoneCached(siteId);
    if (cached !== undefined) return cached;
  }

  // Layer 2: process-level TTL cache
  const processCached = processTzCache.get(siteId);
  if (processCached !== undefined) {
    ctx?.setTimezoneCached(siteId, processCached);
    return processCached;
  }

  // Layer 3: DB query
  const rows = await prisma.$queryRaw<Array<{ timezone: string }>>`
    SELECT timezone FROM "Site" WHERE id = ${siteId}::uuid LIMIT 1
  `;
  const result = rows[0]?.timezone ?? "UTC";
  processTzCache.set(siteId, result);
  ctx?.setTimezoneCached(siteId, result);
  return result;
}

// ── Business date helpers ────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Resolve the business date for a bucket.
 *
 * With a shift schedule: queries ShiftInstance.businessDate.
 * Without a shift schedule: computes the local calendar date from the
 * bucket's startTime using the site's IANA timezone.
 *
 * Returns a Date floored to UTC midnight (suitable for @db.Date).
 */
export async function resolveBusinessDate(
  startTime: Date,
  shiftInstanceId: string | null,
  timezone: string,
): Promise<Date> {
  if (shiftInstanceId) {
    const rows = await prisma.$queryRaw<Array<{ businessDate: Date }>>`
      SELECT "businessDate" FROM "ShiftInstance" WHERE id = ${shiftInstanceId}::uuid LIMIT 1
    `;
    if (rows[0]) return rows[0].businessDate;
  }

  // No shift schedule — derive from local calendar date.
  // Convert UTC startTime to local time, extract the calendar date.
  return getLocalCalendarDate(startTime, timezone);
}

/**
 * Get the local calendar date for a UTC timestamp.
 *
 * Unlike getLocalMidnightUTC (which returns local midnight as a UTC
 * timestamp), this returns a Date representing just the calendar date
 * in the site's timezone, floored to UTC midnight for @db.Date storage.
 *
 * Example: 2026-03-12 22:00 UTC with Africa/Johannesburg (UTC+2)
 *   → local time is 2026-03-13 00:00 SAST
 *   → business date = 2026-03-13 (stored as 2026-03-13 00:00 UTC)
 */
export function getLocalCalendarDate(timestamp: Date, timezone: string): Date {
  const offsetMs = getTimezoneOffsetMs(timezone, timestamp);
  const localMs = timestamp.getTime() + offsetMs;
  const localDayMs = Math.floor(localMs / MS_PER_DAY) * MS_PER_DAY;
  return new Date(localDayMs);
}

// ── Bucket-start helpers ─────────────────────────────────────────

/** Truncate a date to the start of its clock minute. */
function minuteFloor(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

/** Truncate a date to the start of the calendar day (UTC midnight). */
function dayFloor(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * For a given granularity, return the bucket startTime and durationSeconds
 * that contain `timestamp`.
 *
 * HOUR and SHIFT windows are entity-aware — different entities can
 * resolve to different schedules. Only HOUR is a persisted grain; the
 * SHIFT/DAY cases exist for read-time window resolution.
 */
export async function resolveBucket(
  granularity: "MINUTE" | "HOUR" | "SHIFT" | "DAY",
  timestamp: Date,
  entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB",
  entityId: string,
  siteId: string,
  timezone: string,
  ctx?: MetricsContext,
): Promise<{ startTime: Date; durationSeconds: number }> {
  switch (granularity) {
    case "MINUTE":
      return { startTime: minuteFloor(timestamp), durationSeconds: 60 };
    case "HOUR":
      return resolveHourBucketForEntity(entityType, entityId, siteId, timestamp, timezone, ctx);
    case "SHIFT": {
      const shift = await getShiftForEntity(entityType, entityId, siteId, timestamp, ctx);
      if (!shift) {
        // No shift schedule — fall back to full local day.
        return { startTime: getLocalMidnightUTC(timestamp, timezone), durationSeconds: 86400 };
      }
      return shift;
    }
    case "DAY":
      return { startTime: dayFloor(timestamp), durationSeconds: 86400 };
  }
}

// ── Ensure buckets exist ─────────────────────────────────────────

export interface EnsureBucketsInput {
  siteId: string;
  /** Only STATION rows are persisted post-Stage-C. */
  entityType: "STATION";
  /** The station id. */
  entityId: string;
  /**
   * Optional job id: additionally scaffolds the (STATION, station,
   * jobId, HOUR) row for the hour containing `timestamp` (used on job
   * change so the row exists before the first cycle). Open StationJobLog
   * windows are scaffolded regardless.
   */
  jobId?: string;
  timestamp: Date;
  /** Human-readable station name. When omitted, resolved via resolveEntityName(). */
  entityName?: string;
  /** Hierarchical dotted path. When omitted, resolved via resolveEntityPath(). */
  path?: string;
}

/**
 * Ensure that empty STATION-family HOUR rows exist for the current time
 * period.
 *
 * With a shift schedule: creates shift-aligned hour rows and schedules
 * a delayed job for the next shift boundary. Without: creates
 * clock-aligned hour rows for the local day.
 *
 * Per hour bucket a residual row (jobId NULL) is created; for the hour
 * containing `timestamp`, one row per currently-open StationJobLog job
 * (plus input.jobId) is created as well. Uses ON CONFLICT DO NOTHING so
 * existing rows are untouched.
 */
export async function ensureBuckets(input: EnsureBucketsInput, ctx?: MetricsContext) {
  const timezone = await getSiteTimezone(input.siteId, ctx);
  return ensureBucketsInternal(input, timezone, ctx);
}

async function ensureBucketsInternal(input: EnsureBucketsInput, timezone: string, ctx?: MetricsContext) {
  const shift = await getShiftForEntity(input.entityType, input.entityId, input.siteId, input.timestamp, ctx);
  const hourBuckets = await getHourBucketsForEntity(
    input.entityType,
    input.entityId,
    input.siteId,
    input.timestamp,
    timezone,
    ctx,
  );

  // Resolve station path and name (skip DB when caller provides them).
  const [path, entityName] = await Promise.all([
    resolveEntityPath(input.entityType, input.entityId, input.siteId, input.path, ctx),
    resolveEntityName(input.entityType, input.entityId, input.entityName, ctx),
  ]);

  // Resolve businessDate: from ShiftInstance when available, else from local calendar date
  const shiftInstanceId = shift?.shiftInstanceId ?? null;
  const businessDate = await resolveBusinessDate(input.timestamp, shiftInstanceId, timezone);
  const businessShift = shift?.shiftName ?? null;

  // Station's current job (stamped on the residual rows as display info).
  const jobRows = await prisma.$queryRaw<Array<{ currentJobId: string | null; jobName: string | null }>>`
    SELECT s."currentJobId", jb.name AS "jobName"
    FROM "Station" s
    LEFT JOIN "Job" j ON j.id = s."currentJobId"
    LEFT JOIN "JobVersion" jb ON jb.id = j."currentVersionId"
    WHERE s.id = ${input.entityId}::uuid
    LIMIT 1
  `;
  const currentJobId = jobRows[0]?.currentJobId ?? null;
  const currentJobName = jobRows[0]?.jobName ?? null;

  // Jobs to scaffold per-job rows for: every open StationJobLog window
  // plus the explicitly requested jobId (job change scaffolds before the
  // log exists in some paths).
  const openJobRows = await prisma.$queryRaw<Array<{ jobId: string; jobName: string | null }>>`
    SELECT DISTINCT sjl."jobId"::text AS "jobId", jb.name AS "jobName"
    FROM "StationJobLog" sjl
    JOIN "Job" j ON j.id = sjl."jobId"
    LEFT JOIN "JobVersion" jb ON jb.id = j."currentVersionId"
    WHERE sjl."stationId" = ${input.entityId}::uuid
      AND sjl."endTime" IS NULL
  `;
  const jobNames = new Map<string, string | null>(openJobRows.map((r) => [r.jobId, r.jobName]));
  if (input.jobId && !jobNames.has(input.jobId)) {
    const rows = await prisma.$queryRaw<Array<{ jobName: string | null }>>`
      SELECT jb.name AS "jobName"
      FROM "Job" j
      JOIN "JobVersion" jb ON jb.id = j."currentVersionId"
      WHERE j.id = ${input.jobId}::uuid
      LIMIT 1
    `;
    jobNames.set(input.jobId, rows[0]?.jobName ?? null);
  }

  const buckets: Array<{
    siteId: string;
    entityType: "STATION";
    entityId: string;
    jobId: string | null;
    entityName: string;
    path: string;
    granularity: "HOUR";
    granularityName: string;
    startTime: Date;
    durationSeconds: number;
    totalCycles: number;
    shiftInstanceId?: string | null;
    businessDate?: Date | null;
    businessShift?: string | null;
    currentJobId?: string | null;
    currentJobName?: string | null;
  }> = [];

  // Hour rows — tag with the shift instance when shift-aligned,
  // null for clock-aligned hours (no shift schedule).
  const hourShiftInstanceId = shift?.shiftInstanceId ?? null;
  const tsMs = input.timestamp.getTime();
  for (const hb of hourBuckets) {
    // Residual row: jobId NULL, plain station path — the hour's carrier
    // for station time not attributable to any job.
    buckets.push({
      siteId: input.siteId,
      entityType: input.entityType,
      entityId: input.entityId,
      jobId: null,
      entityName,
      path,
      granularity: "HOUR",
      granularityName: "Hour",
      startTime: hb.startTime,
      durationSeconds: hb.durationSeconds,
      totalCycles: 0,
      shiftInstanceId: hourShiftInstanceId,
      businessDate,
      businessShift,
      currentJobId,
      currentJobName,
    });

    // Per-job rows only for the hour containing the timestamp — future
    // hours get their job rows from the base writer / the next ensure.
    const containsTs = hb.startTime.getTime() <= tsMs && tsMs < hb.startTime.getTime() + hb.durationSeconds * 1000;
    if (!containsTs) continue;
    for (const [jobId, jobName] of jobNames) {
      buckets.push({
        siteId: input.siteId,
        entityType: input.entityType,
        entityId: input.entityId,
        jobId,
        entityName: jobName ?? entityName,
        path: `${path}.job.${jobId}`,
        granularity: "HOUR",
        granularityName: "Hour",
        startTime: hb.startTime,
        durationSeconds: hb.durationSeconds,
        totalCycles: 0,
        shiftInstanceId: hourShiftInstanceId,
        businessDate,
        businessShift,
        currentJobId: jobId,
        currentJobName: jobName ?? null,
      });
    }
  }

  // Arm the station's hour-close job for the hour containing the ensure
  // timestamp (its own shift-anchored bounds — never clock-hour math).
  // Deterministic jobId, so the repeated arming from the 60s ensure tick
  // replaces rather than stacks; this is also the recovery path for a
  // close job lost to a dedup race. Fire-and-forget like the shift
  // scheduling below; no-op in processes without the queue.
  {
    const containing = hourBuckets.find(
      (hb) => hb.startTime.getTime() <= tsMs && tsMs < hb.startTime.getTime() + hb.durationSeconds * 1000,
    );
    if (containing) {
      scheduleHourClose({
        siteId: input.siteId,
        stationId: input.entityId,
        hourStart: containing.startTime,
        hourEnd: new Date(containing.startTime.getTime() + containing.durationSeconds * 1000),
      }).catch((err) => {
        console.error(`[metrics] Failed to schedule hour close for station ${input.entityId}:`, err);
      });
    }
  }

  if (buckets.length > 0) {
    const valueRows = buckets.map(
      (b) => Prisma.sql`(
        gen_random_uuid(),
        ${b.siteId}::uuid,
        ${b.entityType}::"BucketEntityType",
        ${b.entityId}::uuid,
        ${b.jobId}::uuid,
        ${b.entityName},
        ${b.path},
        ${b.granularity}::"BucketGranularity",
        ${b.granularityName},
        ${b.startTime},
        ${b.durationSeconds},
        0,
        ${b.shiftInstanceId ?? null},
        ${b.businessDate ?? null},
        ${b.businessShift ?? null},
        ${b.currentJobId ?? null},
        ${b.currentJobName ?? null},
        NOW(), NOW()
      )`,
    );

    // RETURNING with ON CONFLICT DO NOTHING only returns actually-inserted
    // rows, not conflicted ones — so we can publish BucketChange events
    // solely for newly-created buckets and avoid spamming downstream with
    // zero-valued snapshots for buckets that already have real data.
    const inserted = await prisma.$queryRaw<
      Array<{ entityType: string; entityId: string; jobId: string | null; granularity: string; startTime: Date }>
    >`
      INSERT INTO "MetricBucket" (
        id, "siteId", "entityType", "entityId", "jobId", "entityName", path,
        granularity, "granularityName", "startTime", "durationSeconds",
        "totalCycles",
        "shiftInstanceId", "businessDate", "businessShift",
        "currentJobId", "currentJobName",
        "createdAt", "updatedAt"
      ) VALUES ${Prisma.join(valueRows)}
      ON CONFLICT ("entityType", "entityId", "jobId", granularity, "startTime") DO NOTHING
      RETURNING "entityType", "entityId", "jobId", granularity, "startTime"
    `;

    // Schedule next shift boundary job (only when a shift schedule exists).
    // Without a schedule, the 60s safety timer in background-workers
    // handles day rollover by calling ensureBuckets() periodically.
    if (shift) {
      scheduleNextShiftBuckets(input).catch((err) => {
        console.error(
          `[metrics] Failed to schedule next shift buckets for ${input.entityType} ${input.entityId}:`,
          err,
        );
      });
    }

    if (inserted.length > 0) {
      const insertedKeys = new Set(
        inserted.map(
          (r) => `${r.entityType}|${r.entityId}|${r.jobId ?? ""}|${r.granularity}|${r.startTime.toISOString()}`,
        ),
      );
      const changes: BucketChange[] = buckets
        .filter((b) =>
          insertedKeys.has(
            `${b.entityType}|${b.entityId}|${b.jobId ?? ""}|${b.granularity}|${b.startTime.toISOString()}`,
          ),
        )
        .map((b) => ({
          siteId: b.siteId,
          entityType: b.entityType,
          entityId: b.entityId,
          jobId: b.jobId,
          entityName: b.entityName,
          path: b.path,
          granularity: b.granularity,
          granularityName: b.granularityName,
          startTime: b.startTime,
          durationSeconds: b.durationSeconds,
          shiftInstanceId: b.shiftInstanceId ?? null,
          businessDate: b.businessDate ?? null,
          businessShift: b.businessShift ?? null,
          snapshot: {
            ...ZERO_SNAPSHOT,
            shiftInstanceId: b.shiftInstanceId ?? null,
            businessDate: b.businessDate ? b.businessDate.toISOString().slice(0, 10) : null,
            businessShift: b.businessShift ?? null,
            currentJobId: b.currentJobId ?? null,
            currentJobName: b.currentJobName ?? null,
          },
        }));

      if (changes.length > 0) {
        onBucketsChanged(changes).catch((err) => {
          console.error(`[metrics] Failed to notify bucket changes for ${input.entityType} ${input.entityId}:`, err);
        });
      }
    }
  }
}

/**
 * Batch-ensure buckets for multiple entities at once.
 *
 * Shares a single MetricsContext so shift lookups, timezone lookups, etc.
 * are resolved once and reused across all entities.
 */
export async function ensureBucketsBatch(inputs: EnsureBucketsInput[], ctx?: MetricsContext) {
  const sharedCtx = ctx ?? new MetricsContext();

  // Pre-resolve timezones (usually all the same site)
  const siteIds = [...new Set(inputs.map((i) => i.siteId))];
  const tzMap = new Map<string, string>();
  for (const siteId of siteIds) {
    tzMap.set(siteId, await getSiteTimezone(siteId, sharedCtx));
  }

  for (const input of inputs) {
    try {
      // biome-ignore lint/style/noNonNullAssertion: tzMap is populated for every siteId in `siteIds`, and input.siteId ∈ siteIds by construction
      const timezone = tzMap.get(input.siteId)!;
      await ensureBucketsInternal(input, timezone, sharedCtx);
    } catch (err) {
      console.error(`[metrics] Failed to ensure buckets for ${input.entityType} ${input.entityId}:`, err);
    }
  }
}
