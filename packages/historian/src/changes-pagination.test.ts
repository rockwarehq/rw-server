import { beforeEach, describe, expect, test, vi } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { metricBucketSeries } from "./metric-bucket.js";
import { stationStateSeries } from "./station-state.js";
import { isHistorianError } from "./types.js";

const db = vi.hoisted(() => ({
  stationStateLog: { findMany: vi.fn() },
  metricBucket: { findMany: vi.fn() },
  metricBucketLog: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
}));
vi.mock("@rw/db", () => ({ default: db }));

// Evaluate the actual Prisma predicates, ordering and take against a mutable
// fixture, rather than returning canned pages that could hide an infinite loop.
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([field, value]) => {
    if (field === "OR") return value.some((part: Record<string, any>) => matches(row, part));
    if (field === "AND") return value.every((part: Record<string, any>) => matches(row, part));
    if (value instanceof Date) return row[field]?.getTime() === value.getTime();
    if (value && typeof value === "object") {
      return Object.entries(value).every(([op, bound]) => {
        const a = row[field] instanceof Date ? row[field].getTime() : row[field];
        const b = bound instanceof Date ? bound.getTime() : bound;
        if (a == null) return false;
        if (op === "gt") return a > b!;
        if (op === "gte") return a >= b!;
        if (op === "lt") return a < b!;
        if (op === "lte") return a <= b!;
        throw new Error(`Unexpected predicate: ${op}`);
      });
    }
    return row[field] === value;
  });
}

function findRows(rows: Record<string, any>[]) {
  return async ({ where, orderBy, take }: any) =>
    rows
      .filter((row) => matches(row, where))
      .sort((a, b) => {
        for (const order of orderBy) {
          const field = Object.keys(order)[0];
          if (a[field] < b[field]) return -1;
          if (a[field] > b[field]) return 1;
        }
        return 0;
      })
      .slice(0, take)
      .map((row) => ({ ...row }));
}

const now = Date.now();
const range = { from: new Date(now - 4_000), to: new Date(now - 2_000) };
const scope = {
  siteId: "site",
  stationId: "station",
  entityType: "STATION" as const,
  entityId: "station",
  granularity: "HOUR" as const,
};
function row(id: string, timestamp = now - 1_000): Record<string, any> {
  return {
    ...scope,
    id,
    startTime: new Date(now - 3_500),
    endTime: new Date(now - 2_500),
    updatedAt: new Date(timestamp),
    archivedAt: new Date(timestamp),
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$queryRaw.mockResolvedValue([{ now: new Date(now) }]);
  db.stationStateLog.findMany.mockResolvedValue([]);
  db.metricBucket.findMany.mockResolvedValue([]);
  db.metricBucketLog.findMany.mockResolvedValue([]);
});

describe.each([stationStateSeries, metricBucketSeries])("$seriesType change sweeps", (series) => {
  test.each([
    { s: now, i: "not-a-uuid" },
    { s: 1e100, i: "00000000-0000-4000-8000-000000000001" },
  ])("rejects malformed snapshot positions before querying the DB: %s", async (position) => {
    const result = await series.fetchRange(scope, range, {
      limit: 1,
      pageToken: Buffer.from(JSON.stringify(position)).toString("base64url"),
    });
    expect(result).toMatchObject({ code: "BAD_CURSOR" });
    expect(db.stationStateLog.findMany).not.toHaveBeenCalled();
    expect(db.metricBucket.findMany).not.toHaveBeenCalled();
    expect(db.metricBucketLog.findMany).not.toHaveBeenCalled();
  });
  test.each([1, 2, 3])("fully exhausts equal-timestamp rows with limit %i", async (limit) => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
    const future = row("future", now + 1);
    const foreign = { ...row("foreign"), stationId: "other", entityId: "other" };
    db.stationStateLog.findMany.mockImplementation(findRows([...rows, future, foreign]));
    db.metricBucket.findMany.mockImplementation(findRows([...rows.filter((_, i) => i % 2 === 0), future, foreign]));
    db.metricBucketLog.findMany.mockImplementation(findRows(rows.filter((_, i) => i % 2 !== 0)));

    let cursor = encodeCursor(series.seriesType, scope, range, now - 10_000);
    const ids: string[] = [];
    let exhausted = false;
    for (let page = 0; page < 10; page++) {
      const decoded = decodeCursor(cursor, series.seriesType, scope, now);
      if (isHistorianError(decoded)) throw new Error(decoded.error);
      const result = await series.fetchChanges(scope, decoded.range, decoded.watermarkMs, limit, decoded.continuation);
      if (isHistorianError(result)) throw new Error(result.error);
      ids.push(...result.deltas.map((delta) => delta.row.id));
      cursor = encodeCursor(series.seriesType, scope, decoded.range, result.nextWatermarkMs, result.continuation);
      if (!result.hasMore) {
        expect(result.nextWatermarkMs).toBe(now);
        expect(result.continuation).toBeUndefined();
        exhausted = true;
        break;
      }
      expect(result.nextWatermarkMs).toBe(now - 10_000);
      expect(result.continuation?.frontierMs).toBe(now);
      // Subsequent pages must not advance the upper bound with the clock.
      db.$queryRaw.mockResolvedValue([{ now: new Date(now + 100_000) }]);
    }
    expect(exhausted).toBe(true);
    expect(ids).toEqual(rows.map((value) => value.id));
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const decoded = decodeCursor(cursor, series.seriesType, scope, now);
    if (isHistorianError(decoded)) throw new Error(decoded.error);
    const next = await series.fetchChanges(scope, range, decoded.watermarkMs, 100, decoded.continuation);
    if (isHistorianError(next)) throw new Error(next.error);
    expect(next.deltas.some((delta) => delta.row.id === "future")).toBe(true);
  });

  test("progresses within overlap and replays late commits only on the next sweep", async () => {
    const rows = [row("b", now - 3_000), row("c", now - 2_999), row("d", now - 2_998)];
    db.stationStateLog.findMany.mockImplementation(findRows(rows));
    db.metricBucket.findMany.mockImplementation(findRows(rows));
    const first = await series.fetchChanges(scope, range, now - 4_000, 1);
    if (isHistorianError(first)) throw new Error(first.error);
    expect(first.deltas.map((delta) => delta.row.id)).toEqual(["b"]);
    rows.push(row("a-late-commit", now - 3_001));
    const rest = await series.fetchChanges(scope, range, first.nextWatermarkMs, 10, first.continuation);
    if (isHistorianError(rest)) throw new Error(rest.error);
    expect(rest.deltas.map((delta) => delta.row.id)).toEqual(["c", "d"]);
    expect(rest.hasMore).toBe(false);
    const next = await series.fetchChanges(scope, range, rest.nextWatermarkMs, 10);
    if (isHistorianError(next)) throw new Error(next.error);
    expect(next.deltas.map((delta) => delta.row.id)).toEqual(["a-late-commit", "b", "c", "d"]);
  });

  test.each([null, range.to])("preserves series-specific window-exit delivery with end %s", async (to) => {
    const rows = [row("corrected")];
    db.stationStateLog.findMany.mockImplementation(findRows(rows));
    db.metricBucket.findMany.mockImplementation(findRows(rows));
    const window = { ...range, to };
    const snapshot = await series.fetchRange(scope, window, { limit: 10 });
    if (isHistorianError(snapshot)) throw new Error(snapshot.error);
    expect(snapshot.rows.map((value) => value.id)).toEqual(["corrected"]);
    rows[0].startTime = new Date(now - 10_000);
    rows[0].endTime = new Date(now - 5_000);
    rows[0].updatedAt = new Date(now - 1);
    const changes = await series.fetchChanges(scope, window, now - 500, 10);
    if (isHistorianError(changes)) throw new Error(changes.error);
    if (series.seriesType === "stationState") {
      expect(changes.deltas).toHaveLength(1);
      expect(changes.deltas[0].op).toBe("upsert");
      expect(changes.deltas[0].row.startTime).toEqual(rows[0].startTime);
    } else {
      expect(changes.deltas).toEqual([]);
    }
    const refreshed = await series.fetchRange(scope, window, { limit: 10 });
    if (isHistorianError(refreshed)) throw new Error(refreshed.error);
    expect(refreshed.rows).toEqual([]);
  });
});

test("station tombstones are delivered even when the corrected row no longer overlaps", async () => {
  const deleted = {
    ...row("deleted"),
    startTime: new Date(now - 10_000),
    endTime: new Date(now - 5_000),
    deletedAt: new Date(now - 1),
  };
  db.stationStateLog.findMany.mockImplementation(findRows([deleted]));
  const result = await stationStateSeries.fetchChanges(scope, range, now - 500, 1);
  if (isHistorianError(result)) throw new Error(result.error);
  expect(result.deltas).toEqual([{ op: "delete", row: deleted }]);
});

test("closing a pre-window open interval delivers the replacement after it leaves the window", async () => {
  const rows = [{ ...row("open"), startTime: new Date(now - 10_000), endTime: null as Date | null }];
  db.stationStateLog.findMany.mockImplementation(findRows(rows));
  const snapshot = await stationStateSeries.fetchRange(scope, range, { limit: 10 });
  if (isHistorianError(snapshot)) throw new Error(snapshot.error);
  expect(snapshot.rows).toHaveLength(1);
  rows[0].endTime = new Date(now - 5_000);
  const changes = await stationStateSeries.fetchChanges(scope, range, now - 500, 10);
  if (isHistorianError(changes)) throw new Error(changes.error);
  expect(changes.deltas[0].row.endTime).toEqual(rows[0].endTime);
});

test("metric archive wins exact revision collisions at a page boundary", async () => {
  db.metricBucket.findMany.mockImplementation(findRows([row("a"), row("b")]));
  db.metricBucketLog.findMany.mockImplementation(findRows([row("a")]));
  const first = await metricBucketSeries.fetchChanges(scope, range, now - 500, 1);
  if (isHistorianError(first)) throw new Error(first.error);
  expect(first.deltas[0].row.archived).toBe(true);
  expect(first.hasMore).toBe(true);
  const rest = await metricBucketSeries.fetchChanges(scope, range, first.nextWatermarkMs, 1, first.continuation);
  if (isHistorianError(rest)) throw new Error(rest.error);
  expect(rest.deltas.map((delta) => delta.row.id)).toEqual(["b"]);
  expect(rest.hasMore).toBe(false);
});

test.each([null, range.to])("metric change pages retain range boundaries in both tables with end %s", async (to) => {
  const rows = [
    { ...row("before"), startTime: new Date(range.from.getTime() - 1) },
    { ...row("from"), startTime: range.from },
    { ...row("to"), startTime: range.to },
  ];
  db.metricBucket.findMany.mockImplementation(findRows(rows));
  db.metricBucketLog.findMany.mockImplementation(findRows(rows));
  const window = { ...range, to };
  const first = await metricBucketSeries.fetchChanges(scope, window, now - 500, 1);
  if (isHistorianError(first)) throw new Error(first.error);
  expect(first.deltas.map((delta) => delta.row.id)).toEqual(["from"]);
  expect(first.deltas[0].row.archived).toBe(true);
  expect(first.hasMore).toBe(to === null);
  if (first.hasMore) {
    const next = await metricBucketSeries.fetchChanges(scope, window, first.nextWatermarkMs, 1, first.continuation);
    if (isHistorianError(next)) throw new Error(next.error);
    expect(next.deltas.map((delta) => delta.row.id)).toEqual(["to"]);
    expect(next.deltas[0].row.archived).toBe(true);
    expect(next.hasMore).toBe(false);
  }
});
