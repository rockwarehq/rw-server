import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import { metricBucketSeries } from "./metric-bucket.js";
import { isHistorianError, type ResolvedRange } from "./types.js";

// Integration tests (station-state.test.ts conventions): require DATABASE_URL
// and exercise the real two-table union / watermark queries. Each suite
// builds its own isolated workspace/site/workcenter graph.

function at(iso: string) {
  return new Date(iso);
}

const T0 = "2026-07-13T06:00:00.000Z"; // range start
const RANGE: ResolvedRange = { from: at(T0), to: null };

describe.skipIf(!process.env.DATABASE_URL)("historian metricBucket series", () => {
  let siteId: string;
  let otherSiteId: string;
  let workcenterId: string;
  let stationId: string;
  let archivedCollisionId: string;

  const scope = () =>
    ({ siteId, entityType: "WORKCENTER", entityId: workcenterId, granularity: "HOUR" }) as const;

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({
      data: { name: `Historian MB Test ${suffix}`, slug: `historian-mb-${suffix}` },
    });
    const site = await prisma.site.create({
      data: { name: `Historian MB Site ${suffix}`, workspaceId: workspace.id },
    });
    const otherSite = await prisma.site.create({
      data: { name: `Historian MB Other ${suffix}`, workspaceId: workspace.id },
    });
    siteId = site.id;
    otherSiteId = otherSite.id;

    const workcenter = await prisma.workcenter.create({ data: { name: `WC ${suffix}`, siteId } });
    workcenterId = workcenter.id;
    const station = await prisma.station.create({
      data: { name: `Station ${suffix}`, siteId, workcenterId },
    });
    stationId = station.id;

    const base = {
      siteId,
      entityType: "WORKCENTER" as const,
      entityId: workcenterId,
      entityName: "WC",
      granularity: "HOUR" as const,
      granularityName: "Hour",
      durationSeconds: 3600,
      totalCycles: 100,
      badCycles: 5,
      totalItems: 100,
      badItems: 5,
      expectedItems: 120,
      expectedCycles: 120,
      elapsedExpectedItems: 120,
      elapsedPlannedProductionSeconds: 3600,
      runSeconds: 3400,
      idealCycleSeconds: 3100,
    };

    archivedCollisionId = randomUUID();

    // Live table: pre-range hour, two in-range hours (one of which also has a
    // stale live copy of the archived-collision row), a STATION-entity row and
    // a SHIFT-granularity row that the scope must exclude.
    await prisma.metricBucket.createMany({
      data: [
        { ...base, startTime: at("2026-07-13T04:00:00.000Z") }, // pre-range
        { ...base, startTime: at("2026-07-13T07:00:00.000Z"), totalItems: 70 },
        { ...base, startTime: at("2026-07-13T08:00:00.000Z"), totalItems: 80 },
        {
          ...base,
          id: archivedCollisionId,
          startTime: at("2026-07-13T06:00:00.000Z"),
          totalItems: 999, // stale live copy — archived row must win
        },
        {
          ...base,
          entityType: "STATION",
          entityId: stationId,
          startTime: at("2026-07-13T07:00:00.000Z"),
        },
        {
          ...base,
          granularity: "SHIFT",
          granularityName: "Shift 1",
          startTime: at("2026-07-13T06:00:00.000Z"),
        },
      ],
    });

    // Archive table: the corrected copy of the collision row.
    await prisma.metricBucketLog.create({
      data: {
        ...base,
        id: archivedCollisionId,
        startTime: at("2026-07-13T06:00:00.000Z"),
        totalItems: 60,
        updatedAt: at("2026-07-13T07:05:00.000Z"),
      },
    });
  });

  test("assertScope rejects a workcenter under a different site", async () => {
    const result = await metricBucketSeries.assertScope({ ...scope(), siteId: otherSiteId });
    expect(isHistorianError(result)).toBe(true);
    if (isHistorianError(result)) expect(result.code).toBe("FORBIDDEN");
  });

  test("assertScope accepts a station scope under its own site", async () => {
    const result = await metricBucketSeries.assertScope({
      siteId,
      entityType: "STATION",
      entityId: stationId,
      granularity: "HOUR",
    });
    expect(isHistorianError(result)).toBe(false);
  });

  test("fetchRange unions both tables, scoped and ordered, archived winning id collisions", async () => {
    const page = await metricBucketSeries.fetchRange(scope(), RANGE, { limit: 100 });
    expect(isHistorianError(page)).toBe(false);
    if (isHistorianError(page)) return;

    const times = page.rows.map((row) => row.startTime.toISOString());
    expect(times).toEqual([
      "2026-07-13T06:00:00.000Z",
      "2026-07-13T07:00:00.000Z",
      "2026-07-13T08:00:00.000Z",
    ]);

    const collision = page.rows[0];
    expect(collision.id).toBe(archivedCollisionId);
    expect(collision.archived).toBe(true);
    expect(collision.totalItems).toBe(60); // archived copy, not the stale live 999
    expect(page.rows[1].archived).toBe(false);
    expect(page.nextPageToken).toBeNull();
  });

  test("fetchRange pages with a keyset token across the union", async () => {
    const first = await metricBucketSeries.fetchRange(scope(), RANGE, { limit: 2 });
    expect(isHistorianError(first)).toBe(false);
    if (isHistorianError(first)) return;
    expect(first.rows).toHaveLength(2);
    expect(first.nextPageToken).not.toBeNull();

    const second = await metricBucketSeries.fetchRange(scope(), RANGE, {
      limit: 2,
      pageToken: first.nextPageToken,
    });
    expect(isHistorianError(second)).toBe(false);
    if (isHistorianError(second)) return;
    expect(second.rows.map((row) => row.startTime.toISOString())).toEqual([
      "2026-07-13T08:00:00.000Z",
    ]);
    expect(second.nextPageToken).toBeNull();
  });

  test("fetchChanges delivers pure upserts from both change-timestamp columns", async () => {
    const changes = await metricBucketSeries.fetchChanges(scope(), RANGE, 0, 100);
    expect(isHistorianError(changes)).toBe(false);
    if (isHistorianError(changes)) return;

    expect(changes.deltas.every((delta) => delta.op === "upsert")).toBe(true);
    // Archived row rides the archivedAt frontier, not its stale updatedAt.
    const archivedDelta = changes.deltas.find((delta) => delta.row.id === archivedCollisionId && delta.row.archived);
    expect(archivedDelta).toBeDefined();
    expect(changes.hasMore).toBe(false);

    // A live revision after the frontier is picked up by the next poll.
    const live = await prisma.metricBucket.findFirst({
      where: { entityId: workcenterId, startTime: at("2026-07-13T08:00:00.000Z") },
      select: { id: true },
    });
    await prisma.metricBucket.update({
      where: { id: live?.id },
      data: { totalItems: 85 },
    });

    const next = await metricBucketSeries.fetchChanges(scope(), RANGE, changes.nextWatermarkMs, 100);
    expect(isHistorianError(next)).toBe(false);
    if (isHistorianError(next)) return;
    const revised = next.deltas.find((delta) => delta.row.totalItems === 85);
    expect(revised?.op).toBe("upsert");
  });

  test("fetchChanges pages and holds the frontier at the last delivered row", async () => {
    const first = await metricBucketSeries.fetchChanges(scope(), RANGE, 0, 2);
    expect(isHistorianError(first)).toBe(false);
    if (isHistorianError(first)) return;
    expect(first.hasMore).toBe(true);
    expect(first.deltas).toHaveLength(2);
    const lastDelivered = first.deltas[first.deltas.length - 1];
    expect(first.nextWatermarkMs).toBe(lastDelivered.row.changeTs.getTime());
  });

  test("resolveCurrentShift resolves for both workcenter and station scopes", async () => {
    const suffix = randomUUID();
    const pattern = await prisma.shiftPattern.create({ data: { name: `Pattern ${suffix}`, siteId } });
    const definition = await prisma.shiftDefinition.create({
      data: {
        patternId: pattern.id,
        dayOfRotation: 1,
        sortOrder: 1,
        startTime: "06:00",
        durationHrs: 8,
        shiftName: "Shift 1",
      },
    });
    const assignment = await prisma.shiftAssignment.create({
      data: {
        patternId: pattern.id,
        rotationStartDate: at("2026-07-01T00:00:00.000Z"),
        siteId,
        workCenterId: workcenterId,
      },
    });
    const now = Date.now();
    const shift = await prisma.shiftInstance.create({
      data: {
        assignmentId: assignment.id,
        definitionId: definition.id,
        siteId,
        workCenterId: workcenterId,
        shiftName: "Shift 1",
        businessDate: at("2026-07-13T00:00:00.000Z"),
        startTime: new Date(now - 60 * 60 * 1000),
        endTime: new Date(now + 60 * 60 * 1000),
      },
    });

    const wcWindow = await metricBucketSeries.resolveCurrentShift(scope());
    expect(isHistorianError(wcWindow)).toBe(false);
    if (isHistorianError(wcWindow) || wcWindow === null) throw new Error("expected shift window");
    expect(wcWindow.shiftInstanceId).toBe(shift.id);
    expect(wcWindow.range.to).toBeNull();

    const stationWindow = await metricBucketSeries.resolveCurrentShift({
      siteId,
      entityType: "STATION",
      entityId: stationId,
      granularity: "HOUR",
    });
    expect(isHistorianError(stationWindow)).toBe(false);
    if (isHistorianError(stationWindow) || stationWindow === null) {
      throw new Error("expected shift window");
    }
    expect(stationWindow.shiftInstanceId).toBe(shift.id);
  });
});
