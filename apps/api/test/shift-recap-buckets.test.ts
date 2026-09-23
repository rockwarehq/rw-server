import { call } from "@orpc/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { metricBucketLogList } from "../src/rpc/shift-recap.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  station: { findMany: vi.fn() },
  metricBucket: { findMany: vi.fn() },
  metricBucketLog: { findMany: vi.fn() },
}));
vi.mock("@rw/db", () => ({ default: mocks }));
vi.mock("@rw/auth/iam/policy", () => ({ authorize: mocks.authorize }));
vi.mock("@rw/services/facility/shift/shift-comment", () => ({}));
vi.mock("../src/rpc/middleware.js", async () => {
  const { os } = await import("@orpc/server");
  return { authRequired: os, userOrDisplayRequired: os };
});

const input = {
  siteId: "00000000-0000-4000-8000-000000000001",
  shiftInstanceId: "00000000-0000-4000-8000-000000000002",
  workCenterId: "00000000-0000-4000-8000-000000000003",
};
const context = { iam: {} } as any;
const station = { id: "00000000-0000-4000-8000-000000000004", name: "Station A" };
const live = { id: "live", entityType: "STATION", entityId: station.id, entityName: station.name, totalItems: 12 };
const archived = {
  id: "archive",
  entityType: "WORKCENTER",
  entityId: input.workCenterId,
  entityName: "WC",
  totalItems: 40,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue({ ok: true });
  mocks.station.findMany.mockResolvedValue([station]);
  mocks.metricBucket.findMany.mockResolvedValue([]);
  mocks.metricBucketLog.findMany.mockResolvedValue([]);
});

describe("shift recap metric buckets", () => {
  test("partial archives retain live stations, prefer archive IDs, and preserve row values", async () => {
    const collision = { ...live, totalItems: 20, startTime: new Date(), oee: "0.75" };
    mocks.metricBucket.findMany.mockResolvedValue([live, { ...archived, totalItems: 999 }]);
    mocks.metricBucketLog.findMany.mockResolvedValue([archived, collision]);
    const result = await call(metricBucketLogList, input, { context });
    expect(result).toEqual([collision, archived]);
    expect(result[0]).toBe(collision);
    expect(result[1]).toBe(archived);
  });

  test("an archived workcenter does not mask an unarchived station", async () => {
    mocks.metricBucket.findMany.mockResolvedValue([live]);
    mocks.metricBucketLog.findMany.mockResolvedValue([archived]);
    expect(await call(metricBucketLogList, input, { context })).toEqual([live, archived]);
    expect(mocks.metricBucket.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.metricBucketLog.findMany.mock.invocationCallOrder[0],
    );
    // Bucket model: reads check the VIEW tier at the site's plant bucket.
    expect(mocks.authorize).toHaveBeenCalledWith(context.iam, {
      tier: "VIEW",
      scope: { kind: "site", siteId: input.siteId },
    });
    expect(mocks.station.findMany).toHaveBeenCalledWith({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true, name: true },
    });
    const query = mocks.metricBucket.findMany.mock.calls[0][0];
    expect(query.where).toEqual({
      siteId: input.siteId,
      shiftInstanceId: input.shiftInstanceId,
      granularity: "SHIFT",
      OR: [
        { entityType: "WORKCENTER", entityId: input.workCenterId },
        { entityType: "STATION", entityId: { in: [station.id] } },
      ],
    });
    expect(mocks.metricBucketLog.findMany).toHaveBeenCalledWith(query);
    expect(query.select).toMatchObject({ id: true, totalItems: true, oee: true, startTime: true });
  });

  test.each(["live", "archive", "empty"])("handles %s-only results", async (source) => {
    if (source === "live") mocks.metricBucket.findMany.mockResolvedValue([live]);
    if (source === "archive") mocks.metricBucketLog.findMany.mockResolvedValue([archived]);
    expect(await call(metricBucketLogList, input, { context })).toEqual(
      source === "live" ? [live] : source === "archive" ? [archived] : [],
    );
  });

  test("sorts the merged rows by entity type and name", async () => {
    const lastStation = { ...live, id: "station-z", entityName: "Station Z" };
    mocks.metricBucket.findMany.mockResolvedValue([lastStation, archived]);
    mocks.metricBucketLog.findMany.mockResolvedValue([live]);
    expect(await call(metricBucketLogList, input, { context })).toEqual([live, lastStation, archived]);
  });

  test("authorization denial prevents all database reads", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "Denied" });
    await expect(call(metricBucketLogList, input, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.station.findMany).not.toHaveBeenCalled();
    expect(mocks.metricBucket.findMany).not.toHaveBeenCalled();
    expect(mocks.metricBucketLog.findMany).not.toHaveBeenCalled();
  });
});
