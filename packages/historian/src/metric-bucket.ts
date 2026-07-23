import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { WATERMARK_OVERLAP_MS } from "./cursor.js";
import type {
  HistorianError,
  ResolvedRange,
  SeriesChanges,
  SeriesDefinition,
  SeriesPage,
  ShiftWindow,
} from "./types.js";

// metricBucket series (ADR 0008 §4): one entity's bucket timeline presented as
// a single logical series spanning the live table (`MetricBucket`) and the
// archive (`MetricBucketLog`). Row `id` survives the archive move, so the
// archive freeze and retroactive corrections of archived rows are ordinary
// full-row upserts — no tombstones exist for this series. Change timestamp is
// `updatedAt` on the live table and `archivedAt` on the log (archive copies
// the live `updatedAt` verbatim, so it cannot be the log's frontier).

export interface MetricBucketScope {
  siteId: string;
  entityType: "STATION" | "WORKCENTER";
  entityId: string;
  granularity: "HOUR" | "SHIFT" | "DAY";
}

const rowSelect = {
  id: true,
  entityType: true,
  entityId: true,
  entityName: true,
  granularity: true,
  granularityName: true,
  startTime: true,
  durationSeconds: true,
  shiftInstanceId: true,
  businessDate: true,
  businessShift: true,
  totalCycles: true,
  goodCycles: true,
  badCycles: true,
  expectedCycles: true,
  totalItems: true,
  goodItems: true,
  badItems: true,
  expectedItems: true,
  elapsedExpectedCycles: true,
  elapsedExpectedItems: true,
  runSeconds: true,
  downSeconds: true,
  plannedDownSeconds: true,
  unplannedDownSeconds: true,
  idealCycleSeconds: true,
  totalCycleSeconds: true,
  elapsedPlannedProductionSeconds: true,
  availability: true,
  performance: true,
  quality: true,
  oee: true,
  currentJobName: true,
} satisfies Prisma.MetricBucketSelect & Prisma.MetricBucketLogSelect;

type LiveRow = Prisma.MetricBucketGetPayload<{ select: typeof rowSelect }> & { updatedAt: Date };
type LogRow = Prisma.MetricBucketLogGetPayload<{ select: typeof rowSelect }> & { archivedAt: Date };

/** Normalized wire row: one shape across both tables. */
export type MetricBucketRow = Omit<
  Prisma.MetricBucketGetPayload<{ select: typeof rowSelect }>,
  "availability" | "performance" | "quality" | "oee"
> & {
  availability: string | null;
  performance: string | null;
  quality: string | null;
  oee: string | null;
  /** Change timestamp: live `updatedAt` or log `archivedAt`. */
  changeTs: Date;
  /** True once the row has moved to the archive table. */
  archived: boolean;
};

function ratio(value: unknown, clampAtZero: boolean): string | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // ADR 0007 §4: quality/oee are clamped at 0 at read time.
  const clamped = clampAtZero && n < 0 ? 0 : n;
  return String(clamped);
}

function normalizeRow(row: LiveRow | LogRow, archived: boolean): MetricBucketRow {
  const { availability, performance, quality, oee, ...rest } = row;
  const changeTs = archived ? (row as LogRow).archivedAt : (row as LiveRow).updatedAt;
  return {
    ...rest,
    availability: ratio(availability, false),
    performance: ratio(performance, false),
    quality: ratio(quality, true),
    oee: ratio(oee, true),
    changeTs,
    archived,
  };
}

function scopeWhere(scope: MetricBucketScope): Prisma.MetricBucketWhereInput &
  Prisma.MetricBucketLogWhereInput {
  return {
    siteId: scope.siteId,
    entityType: scope.entityType,
    entityId: scope.entityId,
    granularity: scope.granularity,
  };
}

/** Point-in-range predicate: `startTime >= from AND (to IS NULL OR startTime < to)`. */
function rangeWhere(range: ResolvedRange): Prisma.MetricBucketWhereInput &
  Prisma.MetricBucketLogWhereInput {
  const startTime: Prisma.DateTimeFilter = { gte: range.from };
  if (range.to) startTime.lt = range.to;
  return { startTime };
}

interface PageToken {
  s: number; // startTime epoch-ms of the last row
  i: string; // id of the last row
}

function decodePageToken(token: string): PageToken | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as PageToken;
    if (typeof parsed?.s !== "number" || typeof parsed?.i !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function encodePageToken(row: { startTime: Date; id: string }): string {
  const token: PageToken = { s: row.startTime.getTime(), i: row.id };
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

function keysetAfter(token: PageToken): Prisma.MetricBucketWhereInput & Prisma.MetricBucketLogWhereInput {
  const after = new Date(token.s);
  return {
    OR: [{ startTime: { gt: after } }, { startTime: after, id: { gt: token.i } }],
  };
}

async function assertScope(scope: MetricBucketScope): Promise<HistorianError | { ok: true }> {
  if (scope.entityType === "STATION") {
    const station = await prisma.station.findUnique({
      where: { id: scope.entityId },
      select: { siteId: true },
    });
    if (!station) return { error: "Station not found", code: "NOT_FOUND" };
    if (station.siteId !== scope.siteId) {
      return { error: "Station does not belong to this site", code: "FORBIDDEN" };
    }
    return { ok: true };
  }

  const workcenter = await prisma.workcenter.findUnique({
    where: { id: scope.entityId },
    select: { siteId: true },
  });
  if (!workcenter) return { error: "Workcenter not found", code: "NOT_FOUND" };
  if (workcenter.siteId !== scope.siteId) {
    return { error: "Workcenter does not belong to this site", code: "FORBIDDEN" };
  }
  return { ok: true };
}

async function resolveCurrentShift(scope: MetricBucketScope): Promise<ShiftWindow | null | HistorianError> {
  // Null workcenter (unassigned station) matches site-level default shifts,
  // mirroring station-state's lookup.
  let workCenterId: string | null;
  if (scope.entityType === "WORKCENTER") {
    workCenterId = scope.entityId;
  } else {
    const station = await prisma.station.findUnique({
      where: { id: scope.entityId },
      select: { workcenterId: true },
    });
    if (!station) return { error: "Station not found", code: "NOT_FOUND" };
    workCenterId = station.workcenterId;
  }

  const now = new Date();
  const shift = await prisma.shiftInstance.findFirst({
    where: {
      siteId: scope.siteId,
      workCenterId,
      startTime: { lte: now },
      endTime: { gte: now },
    },
    orderBy: { startTime: "desc" },
    select: { id: true, shiftName: true, startTime: true, endTime: true },
  });
  if (!shift) return null;

  return {
    // Open-ended forward: overtime buckets past the scheduled end still
    // arrive as ordinary upserts; the client clips for display.
    range: { from: shift.startTime, to: null },
    shiftInstanceId: shift.id,
    shiftName: shift.shiftName,
    shiftStart: shift.startTime,
    shiftEnd: shift.endTime,
  };
}

/** Merge live + archived rows in (startTime, id) order, archived rows winning on id collision. */
function mergeByStartTime(live: MetricBucketRow[], archived: MetricBucketRow[]): MetricBucketRow[] {
  const archivedIds = new Set(archived.map((row) => row.id));
  return [...archived, ...live.filter((row) => !archivedIds.has(row.id))].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

async function fetchRange(
  scope: MetricBucketScope,
  range: ResolvedRange,
  page: { limit: number; pageToken?: string | null },
): Promise<SeriesPage<MetricBucketRow> | HistorianError> {
  const where = { ...scopeWhere(scope), ...rangeWhere(range) };

  if (page.pageToken) {
    const token = decodePageToken(page.pageToken);
    if (!token) return { error: "Malformed page token", code: "BAD_CURSOR" };
    where.AND = [keysetAfter(token)];
  }

  // Both tables share the keyset predicate and ordering, so merging the two
  // (limit+1)-row pages and re-cutting at limit preserves keyset semantics.
  const take = page.limit + 1;
  const orderBy = [{ startTime: "asc" as const }, { id: "asc" as const }];
  const [live, archived] = await Promise.all([
    prisma.metricBucket.findMany({
      where,
      select: { ...rowSelect, updatedAt: true },
      orderBy,
      take,
    }),
    prisma.metricBucketLog.findMany({
      where,
      select: { ...rowSelect, archivedAt: true },
      orderBy,
      take,
    }),
  ]);

  const merged = mergeByStartTime(
    live.map((row) => normalizeRow(row as LiveRow, false)),
    archived.map((row) => normalizeRow(row as LogRow, true)),
  );

  const hasMore = merged.length > page.limit;
  const data = hasMore ? merged.slice(0, page.limit) : merged;
  const last = data[data.length - 1];

  return {
    rows: data,
    nextPageToken: hasMore && last ? encodePageToken(last) : null,
  };
}

async function fetchChanges(
  scope: MetricBucketScope,
  range: ResolvedRange,
  watermarkMs: number,
  limit: number,
): Promise<SeriesChanges<MetricBucketRow> | HistorianError> {
  const where = { ...scopeWhere(scope), ...rangeWhere(range) };
  const frontier = new Date(watermarkMs - WATERMARK_OVERLAP_MS);
  const take = limit + 1;

  // The watermark comes from the database clock inside the same transaction
  // as the delta scan (see station-state.ts for the rationale).
  const [clock, live, archived] = await prisma.$transaction([
    prisma.$queryRaw<[{ now: Date }]>`SELECT now() AS now`,
    prisma.metricBucket.findMany({
      where: { ...where, updatedAt: { gt: frontier } },
      select: { ...rowSelect, updatedAt: true },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take,
    }),
    prisma.metricBucketLog.findMany({
      where: { ...where, archivedAt: { gt: frontier } },
      select: { ...rowSelect, archivedAt: true },
      orderBy: [{ archivedAt: "asc" }, { id: "asc" }],
      take,
    }),
  ]);

  const merged = [
    ...live.map((row) => normalizeRow(row as LiveRow, false)),
    ...archived.map((row) => normalizeRow(row as LogRow, true)),
  ].sort(
    (a, b) => a.changeTs.getTime() - b.changeTs.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const hasMore = merged.length > limit;
  const data = hasMore ? merged.slice(0, limit) : merged;
  const last = data[data.length - 1];

  return {
    // Pure upserts: archive is an id-preserving move, corrections rewrite
    // rows in place — this series has no tombstones.
    deltas: data.map((row) => ({ op: "upsert" as const, row })),
    // When a page is full the frontier stops at the last delivered row so the
    // next page continues from there; the overlap window makes the boundary
    // redelivery harmless.
    nextWatermarkMs: hasMore && last ? last.changeTs.getTime() : clock[0].now.getTime(),
    hasMore,
  };
}

export const metricBucketSeries: SeriesDefinition<MetricBucketScope, MetricBucketRow> = {
  seriesType: "metricBucket",
  pollIntervalMs: 2_000,
  assertScope,
  resolveCurrentShift,
  fetchRange,
  fetchChanges,
};
