import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import { stationStateSeries } from "./station-state.js";
import { isHistorianError, type ResolvedRange } from "./types.js";

// Integration tests (document.test.ts conventions): require DATABASE_URL and
// exercise the real overlap/watermark queries. Each suite builds its own
// isolated workspace/site/station graph.

function at(iso: string) {
  return new Date(iso);
}

const T0 = "2026-07-13T06:00:00.000Z"; // shift start
const RANGE: ResolvedRange = { from: at(T0), to: null };

// Skip (like the api Tier 2 suites) rather than throw when no database is
// configured — CI's unit-test job runs without one.
describe.skipIf(!process.env.DATABASE_URL)("historian stationState series", () => {
  let siteId: string;
  let otherSiteId: string;
  let workcenterId: string;
  let stationId: string;
  let workspaceId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({
      data: { name: `Historian Test ${suffix}`, slug: `historian-test-${suffix}` },
    });
    workspaceId = workspace.id;
    const site = await prisma.site.create({
      data: { name: `Historian Site ${suffix}`, workspaceId: workspace.id },
    });
    const otherSite = await prisma.site.create({
      data: { name: `Historian Other Site ${suffix}`, workspaceId: workspace.id },
    });
    siteId = site.id;
    otherSiteId = otherSite.id;

    const workcenter = await prisma.workcenter.create({
      data: { name: `WC ${suffix}`, siteId },
    });
    workcenterId = workcenter.id;

    const station = await prisma.station.create({
      data: { name: `Station ${suffix}`, siteId, workcenterId },
    });
    stationId = station.id;

    // Timeline: a closed pre-range stretch, a stretch straddling the range
    // start, a closed in-range stretch, a soft-deleted in-range stretch, and
    // the open current stretch.
    await prisma.stationStateLog.createMany({
      data: [
        {
          stationId,
          state: "UP",
          status: "UP",
          blockId: "blk-before",
          startTime: at("2026-07-13T04:00:00.000Z"),
          endTime: at("2026-07-13T05:00:00.000Z"),
        },
        {
          stationId,
          state: "UP",
          status: "UP",
          blockId: "blk-straddle",
          startTime: at("2026-07-13T05:30:00.000Z"),
          endTime: at("2026-07-13T06:30:00.000Z"),
        },
        {
          stationId,
          state: "DOWN",
          status: "DOWN",
          blockId: "blk-down",
          startTime: at("2026-07-13T06:30:00.000Z"),
          endTime: at("2026-07-13T07:00:00.000Z"),
        },
        {
          stationId,
          state: "UP",
          status: "SLOW",
          blockId: "blk-deleted",
          startTime: at("2026-07-13T07:00:00.000Z"),
          endTime: at("2026-07-13T07:15:00.000Z"),
          deletedAt: at("2026-07-13T08:00:00.000Z"),
        },
        {
          stationId,
          state: "UP",
          status: "FAST",
          blockId: "blk-open",
          startTime: at("2026-07-13T07:15:00.000Z"),
          endTime: null,
        },
      ],
    });
  });

  afterAll(async () => {
    if (!workspaceId) return;
    const sites = { workspaceId };
    await prisma.stationStateLog.deleteMany({ where: { station: { site: sites } } });
    await prisma.shiftInstance.deleteMany({ where: { site: sites } });
    await prisma.shiftAssignment.deleteMany({ where: { site: sites } });
    await prisma.shiftPattern.deleteMany({ where: { site: sites } });
    await prisma.station.deleteMany({ where: { site: sites } });
    await prisma.workcenter.deleteMany({ where: { site: sites } });
    await prisma.site.deleteMany({ where: sites });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  });

  test("legacy null stamps fall back independently, while foreign historical stamps survive station moves", async () => {
    const otherWorkcenter = await prisma.workcenter.create({ data: { siteId, name: `Other WC ${randomUUID()}` } });
    const station = await prisma.station.create({ data: { siteId, workcenterId, name: `Legacy ${randomUUID()}` } });
    const rows = [
      { blockId: "legacy", siteId: null, workcenterId: null },
      { blockId: "site-only", siteId, workcenterId: null },
      { blockId: "wc-only", siteId: null, workcenterId },
      { blockId: "owned", siteId, workcenterId },
      { blockId: "foreign-wc", siteId, workcenterId: otherWorkcenter.id },
      { blockId: "foreign-site", siteId: otherSiteId, workcenterId },
      { blockId: "foreign-site-null-wc", siteId: otherSiteId, workcenterId: null },
      { blockId: "null-site-foreign-wc", siteId: null, workcenterId: otherWorkcenter.id },
    ];
    await prisma.stationStateLog.createMany({
      data: rows.map((row, index) => ({
        ...row,
        stationId: station.id,
        state: "UP",
        startTime: new Date(at(T0).getTime() + index * 1000),
        endTime: new Date(at(T0).getTime() + (index + 1) * 1000),
        ...(row.blockId === "site-only" ? { deletedAt: new Date() } : {}),
      })),
    });
    const scope = { siteId, stationId: station.id, workcenterIds: [workcenterId] };
    const first = await stationStateSeries.fetchRange(scope, RANGE, { limit: 2 });
    if (isHistorianError(first)) throw new Error(first.error);
    expect(first.nextPageToken).not.toBeNull();
    const second = await stationStateSeries.fetchRange(scope, RANGE, { limit: 20, pageToken: first.nextPageToken });
    if (isHistorianError(second)) throw new Error(second.error);
    expect([...first.rows, ...second.rows].map((row) => row.blockId)).toEqual([
      "legacy",
      "site-only",
      "wc-only",
      "owned",
    ]);
    const changes = await stationStateSeries.fetchChanges(scope, RANGE, 0, 100);
    if (isHistorianError(changes)) throw new Error(changes.error);
    expect(changes.deltas.map((delta) => delta.row.blockId).sort()).toEqual([
      "legacy",
      "owned",
      "site-only",
      "wc-only",
    ]);
    expect(changes.deltas.find((delta) => delta.row.blockId === "site-only")?.op).toBe("delete");

    await prisma.station.update({ where: { id: station.id }, data: { workcenterId: otherWorkcenter.id } });
    const moved = await stationStateSeries.fetchRange({ ...scope, workcenterIds: [otherWorkcenter.id] }, RANGE, {
      limit: 100,
    });
    if (isHistorianError(moved)) throw new Error(moved.error);
    expect(moved.rows.map((row) => row.blockId)).toEqual(["legacy", "site-only", "foreign-wc", "null-site-foreign-wc"]);
    const oldScope = await stationStateSeries.fetchRange(scope, RANGE, { limit: 100 });
    if (isHistorianError(oldScope)) throw new Error(oldScope.error);
    expect(oldScope.rows.map((row) => row.blockId)).toEqual(["wc-only", "owned"]);
  });

  test("assertScope rejects a station under a different site", async () => {
    const result = await stationStateSeries.assertScope({ siteId: otherSiteId, stationId });
    expect(isHistorianError(result)).toBe(true);
    if (isHistorianError(result)) expect(result.code).toBe("FORBIDDEN");
  });

  test("assertScope accepts the station's own site", async () => {
    const result = await stationStateSeries.assertScope({ siteId, stationId });
    expect(isHistorianError(result)).toBe(false);
  });

  test("fetchRange returns overlap-inclusive, unclamped rows including soft-deleted and open stretches", async () => {
    const page = await stationStateSeries.fetchRange({ siteId, stationId }, RANGE, { limit: 100 });
    expect(isHistorianError(page)).toBe(false);
    if (isHistorianError(page)) return;

    const blocks = page.rows.map((row) => row.blockId);
    // Pre-range stretch excluded; straddler included and UNCLAMPED.
    expect(blocks).toEqual(["blk-straddle", "blk-down", "blk-deleted", "blk-open"]);

    const straddle = page.rows[0];
    expect(straddle.startTime.getTime()).toBe(at("2026-07-13T05:30:00.000Z").getTime());

    const deleted = page.rows.find((row) => row.blockId === "blk-deleted");
    expect(deleted?.deletedAt).not.toBeNull();

    const open = page.rows.find((row) => row.blockId === "blk-open");
    expect(open?.endTime).toBeNull();
    expect(page.nextPageToken).toBeNull();
  });

  test("fetchRange pages with a keyset token", async () => {
    const first = await stationStateSeries.fetchRange({ siteId, stationId }, RANGE, { limit: 2 });
    expect(isHistorianError(first)).toBe(false);
    if (isHistorianError(first)) return;
    expect(first.rows).toHaveLength(2);
    expect(first.nextPageToken).not.toBeNull();

    const second = await stationStateSeries.fetchRange({ siteId, stationId }, RANGE, {
      limit: 100,
      pageToken: first.nextPageToken,
    });
    expect(isHistorianError(second)).toBe(false);
    if (isHistorianError(second)) return;

    const blocks = [...first.rows, ...second.rows].map((row) => row.blockId);
    expect(blocks).toEqual(["blk-straddle", "blk-down", "blk-deleted", "blk-open"]);
    expect(second.nextPageToken).toBeNull();
  });

  test("fetchChanges delivers revisions past the watermark as upserts and tombstones", async () => {
    // Watermark in the past: everything in range is a delta.
    const changes = await stationStateSeries.fetchChanges({ siteId, stationId }, RANGE, 0, 100);
    expect(isHistorianError(changes)).toBe(false);
    if (isHistorianError(changes)) return;

    const byBlock = new Map(changes.deltas.map((delta) => [delta.row.blockId, delta]));
    expect(byBlock.get("blk-deleted")?.op).toBe("delete");
    expect(byBlock.get("blk-open")?.op).toBe("upsert");
    expect(changes.hasMore).toBe(false);
    expect(changes.nextWatermarkMs).toBeGreaterThan(0);

    // A revision after the frontier is picked up by the next poll.
    const openRow = await prisma.stationStateLog.findFirst({
      where: { stationId, blockId: "blk-open" },
      select: { id: true },
    });
    await prisma.stationStateLog.update({
      where: { id: openRow?.id },
      data: { endTime: at("2026-07-13T09:00:00.000Z") },
    });

    const next = await stationStateSeries.fetchChanges({ siteId, stationId }, RANGE, changes.nextWatermarkMs, 100);
    expect(isHistorianError(next)).toBe(false);
    if (isHistorianError(next)) return;
    const closed = next.deltas.find((delta) => delta.row.blockId === "blk-open");
    expect(closed?.op).toBe("upsert");
    expect(closed?.row.endTime?.getTime()).toBe(at("2026-07-13T09:00:00.000Z").getTime());
  });

  test("fetchChanges pages with a separate continuation and stable watermark", async () => {
    await prisma.stationStateLog.updateMany({
      where: { stationId },
      data: { updatedAt: new Date(Date.now() - 1_000) },
    });
    const first = await stationStateSeries.fetchChanges({ siteId, stationId }, RANGE, 0, 2);
    expect(isHistorianError(first)).toBe(false);
    if (isHistorianError(first)) return;
    expect(first.hasMore).toBe(true);
    expect(first.deltas).toHaveLength(2);
    const lastDelivered = first.deltas[first.deltas.length - 1];
    expect(first.nextWatermarkMs).toBe(0);
    expect(first.continuation?.updatedAtMs).toBe(lastDelivered.row.updatedAt.getTime());
    expect(first.continuation?.id).toBe(lastDelivered.row.id);
    const ids = first.deltas.map((delta) => delta.row.id);
    let page = first;
    for (let i = 0; page.hasMore && i < 10; i++) {
      const next = await stationStateSeries.fetchChanges(
        { siteId, stationId },
        RANGE,
        page.nextWatermarkMs,
        2,
        page.continuation,
      );
      if (isHistorianError(next)) throw new Error(next.error);
      ids.push(...next.deltas.map((delta) => delta.row.id));
      page = next;
    }
    expect(page.hasMore).toBe(false);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(page.nextWatermarkMs).toBe(first.continuation?.frontierMs);
  });

  test("fetchChanges delivers a correction and tombstone after an interval leaves the range", async () => {
    const original = await prisma.stationStateLog.findFirstOrThrow({ where: { stationId, blockId: "blk-straddle" } });
    await prisma.stationStateLog.update({
      where: { id: original.id },
      data: {
        endTime: at("2026-07-13T05:45:00.000Z"),
        deletedAt: new Date(),
      },
    });
    const changes = await stationStateSeries.fetchChanges({ siteId, stationId }, RANGE, Date.now() - 1_000, 100);
    if (isHistorianError(changes)) throw new Error(changes.error);
    const revised = changes.deltas.find((delta) => delta.row.id === original.id);
    expect(revised?.op).toBe("delete");
    expect(revised?.row.endTime).toEqual(at("2026-07-13T05:45:00.000Z"));
    const snapshot = await stationStateSeries.fetchRange({ siteId, stationId }, RANGE, { limit: 100 });
    if (isHistorianError(snapshot)) throw new Error(snapshot.error);
    expect(snapshot.rows.some((row) => row.id === original.id)).toBe(false);
  });

  test("resolveCurrentShift resolves the station's workcenter shift", async () => {
    const suffix = randomUUID();
    const pattern = await prisma.shiftPattern.create({
      data: { name: `Pattern ${suffix}`, siteId },
    });
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

    const window = await stationStateSeries.resolveCurrentShift({ siteId, stationId });
    expect(isHistorianError(window)).toBe(false);
    if (isHistorianError(window) || window === null) {
      throw new Error("expected an active shift window");
    }
    expect(window.shiftInstanceId).toBe(shift.id);
    expect(window.range.from.getTime()).toBe(shift.startTime.getTime());
    expect(window.range.to).toBeNull();
    expect(window.shiftEnd.getTime()).toBe(shift.endTime.getTime());
  });
});
