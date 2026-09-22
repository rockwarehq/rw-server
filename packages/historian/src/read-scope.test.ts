import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  states: vi.fn(async () => []),
  live: vi.fn(async () => []),
  archive: vi.fn(async () => []),
}));
vi.mock("@rw/db", () => ({
  default: {
    stationStateLog: { findMany: mocks.states },
    metricBucket: { findMany: mocks.live },
    metricBucketLog: { findMany: mocks.archive },
    $transaction: async (queries: Promise<unknown>[]) => Promise.all(queries),
    $queryRaw: async () => [{ now: new Date(1000) }],
  },
}));
import { stationStateSeries } from "./station-state.js";
import { metricBucketSeries } from "./metric-bucket.js";

const siteId = "11111111-1111-4111-8111-111111111111";
const stationId = "22222222-2222-4222-8222-222222222222";
const workcenterIds = ["33333333-3333-4333-8333-333333333333"];
const range = { from: new Date(0), to: null };
const pageToken = Buffer.from(JSON.stringify({ s: 10, i: stationId })).toString("base64url");
beforeEach(() => vi.clearAllMocks());

describe("historian grant predicates survive paging and replay", () => {
  it("uses the historical state workcenter stamp for snapshots and tombstones", async () => {
    const scope = { siteId, stationId, workcenterIds };
    const grants = [
      { OR: [{ siteId }, { siteId: null, station: { siteId } }] },
      {
        OR: [
          { workcenterId: { in: workcenterIds } },
          { workcenterId: null, station: { siteId, workcenterId: { in: workcenterIds } } },
        ],
      },
    ];
    await stationStateSeries.fetchRange(scope, range, { limit: 10, pageToken });
    expect(mocks.states).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stationId, AND: expect.arrayContaining(grants) }),
      }),
    );
    await stationStateSeries.fetchChanges(scope, range, 0, 10);
    expect(mocks.states).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stationId, AND: grants }),
      }),
    );
  });
  it("ANDs bucket ownership with keyset pagination on both live and archive tables", async () => {
    const scope = {
      siteId,
      entityType: "STATION" as const,
      entityId: stationId,
      granularity: "HOUR" as const,
      workcenterIds,
    };
    await metricBucketSeries.fetchRange(scope, range, { limit: 10, pageToken });
    const grants = {
      OR: [
        { path: { startsWith: `site.${siteId}.workcenter.${workcenterIds[0]}.` } },
        { path: { equals: `site.${siteId}.workcenter.${workcenterIds[0]}` } },
      ],
    };
    for (const query of [mocks.live, mocks.archive])
      expect(query).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ AND: expect.arrayContaining([grants]) }),
        }),
      );
    await metricBucketSeries.fetchChanges(scope, range, 0, 10);
    for (const query of [mocks.live, mocks.archive])
      expect(query).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ AND: [grants], OR: expect.any(Array) }),
        }),
      );
  });
});
