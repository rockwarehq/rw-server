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

// stationState series (ADR 0008 §4): the raw StationStateLog timeline for one
// station. Rows are returned unclamped to the query window (clamping would
// make a row's shape depend on the query that fetched it and break upsert
// identity across deltas — display clamping is the client's job) and
// soft-deleted rows are never filtered (ADR 0007 §1) — deltas deliver them as
// tombstones. Open stretches (endTime null) receive zero writes while they
// grow; clients render them as "until now".

export interface StationStateScope {
  siteId: string;
  stationId: string;
}

const rowInclude = {
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
} satisfies Prisma.StationStateLogInclude;

export type StationStateRow = Prisma.StationStateLogGetPayload<{ include: typeof rowInclude }>;

/**
 * Interval-overlap window predicate: `startTime < to AND (endTime > from OR
 * endTime IS NULL)`. Soft-deleted rows intentionally included.
 */
function overlapWhere(scope: StationStateScope, range: ResolvedRange): Prisma.StationStateLogWhereInput {
  const where: Prisma.StationStateLogWhereInput = {
    stationId: scope.stationId,
    OR: [{ endTime: { gt: range.from } }, { endTime: null }],
  };
  if (range.to) {
    where.startTime = { lt: range.to };
  }
  return where;
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

async function assertScope(scope: StationStateScope): Promise<HistorianError | { ok: true }> {
  const station = await prisma.station.findUnique({
    where: { id: scope.stationId },
    select: { siteId: true },
  });
  if (!station) {
    return { error: "Station not found", code: "NOT_FOUND" };
  }
  if (station.siteId !== scope.siteId) {
    return { error: "Station does not belong to this site", code: "FORBIDDEN" };
  }
  return { ok: true };
}

async function resolveCurrentShift(scope: StationStateScope): Promise<ShiftWindow | null | HistorianError> {
  const station = await prisma.station.findUnique({
    where: { id: scope.stationId },
    select: { workcenterId: true },
  });
  if (!station) {
    return { error: "Station not found", code: "NOT_FOUND" };
  }

  const now = new Date();
  const shift = await prisma.shiftInstance.findFirst({
    where: {
      siteId: scope.siteId,
      workCenterId: station.workcenterId,
      startTime: { lte: now },
      endTime: { gte: now },
    },
    orderBy: { startTime: "desc" },
    select: { id: true, shiftName: true, startTime: true, endTime: true },
  });
  if (!shift) return null;

  return {
    // Open-ended forward: overtime rows past the scheduled end still arrive
    // as ordinary upserts; the client clips for display.
    range: { from: shift.startTime, to: null },
    shiftInstanceId: shift.id,
    shiftName: shift.shiftName,
    shiftStart: shift.startTime,
    shiftEnd: shift.endTime,
  };
}

async function fetchRange(
  scope: StationStateScope,
  range: ResolvedRange,
  page: { limit: number; pageToken?: string | null },
): Promise<SeriesPage<StationStateRow> | HistorianError> {
  const where = overlapWhere(scope, range);

  if (page.pageToken) {
    const token = decodePageToken(page.pageToken);
    if (!token) {
      return { error: "Malformed page token", code: "BAD_CURSOR" };
    }
    const after = new Date(token.s);
    where.AND = [
      {
        OR: [{ startTime: { gt: after } }, { startTime: after, id: { gt: token.i } }],
      },
    ];
  }

  const rows = await prisma.stationStateLog.findMany({
    where,
    include: rowInclude,
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
    take: page.limit + 1,
  });

  const hasMore = rows.length > page.limit;
  const data = hasMore ? rows.slice(0, page.limit) : rows;
  const last = data[data.length - 1];

  return {
    rows: data,
    nextPageToken: hasMore && last ? encodePageToken(last) : null,
  };
}

async function fetchChanges(
  scope: StationStateScope,
  range: ResolvedRange,
  watermarkMs: number,
  limit: number,
): Promise<SeriesChanges<StationStateRow> | HistorianError> {
  const where = overlapWhere(scope, range);
  where.updatedAt = { gt: new Date(watermarkMs - WATERMARK_OVERLAP_MS) };

  // The watermark comes from the database clock inside the same transaction
  // as the delta scan — writers span Postgres NOW() and the JS clocks of
  // multiple processes, so an app clock cannot be the frontier.
  const [clock, rows] = await prisma.$transaction([
    prisma.$queryRaw<[{ now: Date }]>`SELECT now() AS now`,
    prisma.stationStateLog.findMany({
      where,
      include: rowInclude,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    }),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    deltas: data.map((row) => ({
      op: row.deletedAt ? ("delete" as const) : ("upsert" as const),
      row,
    })),
    // When a page is full the frontier stops at the last delivered row so the
    // next page continues from there; the overlap window makes the boundary
    // redelivery harmless.
    nextWatermarkMs: hasMore && last ? last.updatedAt.getTime() : clock[0].now.getTime(),
    hasMore,
  };
}

export const stationStateSeries: SeriesDefinition<StationStateScope, StationStateRow> = {
  seriesType: "stationState",
  pollIntervalMs: 2_000,
  assertScope,
  resolveCurrentShift,
  fetchRange,
  fetchChanges,
};
