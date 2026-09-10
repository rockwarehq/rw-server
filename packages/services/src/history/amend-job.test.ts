import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import { createFromCycle } from "../inventory/inventory.js";
import { amendJobHistory } from "./amend-job.js";

// Integration test: requires DATABASE_URL. Builds an isolated site with two
// jobs making different products, a J1 run with cycles/items/state rows, and
// asserts that amending part of the run to J2 rewrites every fact table.

const hour = 60 * 60 * 1000;

describe.skipIf(!process.env.DATABASE_URL)("amendJobHistory", () => {
  let siteId: string;
  let stationId: string;
  let j1: { id: string; versionId: string; productId: string };
  let j2: { id: string; versionId: string; productId: string };
  const t0 = new Date(Date.now() - 6 * hour);
  const at = (h: number) => new Date(t0.getTime() + h * hour);

  async function makeJob(name: string) {
    const product = await prisma.product.create({ data: { siteId } });
    const pv = await prisma.productVersion.create({ data: { productId: product.id, version: 1, sku: name } });
    await prisma.product.update({ where: { id: product.id }, data: { currentVersionId: pv.id } });
    const job = await prisma.job.create({ data: { siteId } });
    const jv = await prisma.jobVersion.create({ data: { jobId: job.id, version: 1, name, standardCycle: 10 } });
    await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: jv.id } });
    const jp = await prisma.jobProduct.create({ data: { jobId: job.id, productId: product.id } });
    const jpv = await prisma.jobProductVersion.create({ data: { jobProductId: jp.id, version: 1, quantity: 2 } });
    await prisma.jobProduct.update({ where: { id: jp.id }, data: { currentVersionId: jpv.id } });
    return { id: job.id, versionId: jv.id, productId: product.id };
  }

  async function recordCycle(end: Date, job: typeof j1) {
    await prisma.$transaction(async (tx) => {
      const cycle = await tx.cycle.create({
        data: {
          siteId,
          stationId,
          jobId: job.id,
          jobVersionId: job.versionId,
          start: new Date(end.getTime() - 10_000),
          end,
          cycleStatus: "GOOD",
          standardCycle: 10,
        },
      });
      await createFromCycle(tx, cycle.id, job.id, undefined, null, {
        siteId,
        stationId,
        workcenterId: null,
        jobId: job.id,
        shiftInstanceId: null,
        businessDate: null,
      });
    });
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({ data: { name: `Amend ${suffix}`, slug: `amend-${suffix}` } });
    siteId = (await prisma.site.create({ data: { name: `Amend Site ${suffix}`, workspaceId: workspace.id } })).id;
    j1 = await makeJob("J1");
    j2 = await makeJob("J2");
    stationId = (await prisma.station.create({ data: { siteId, name: "Press", currentJobId: j1.id } })).id;

    // J1 ran from t0 and is still the open assignment; cycles every hour; one UP period, one DOWN period.
    await prisma.stationJobLog.create({
      data: { stationId, siteId, jobId: j1.id, jobVersionId: j1.versionId, startTime: at(0), standardCycle: 10 },
    });
    for (const h of [1, 2, 3, 4, 5]) await recordCycle(at(h), j1);
    await prisma.stationStateLog.createMany({
      data: [
        { stationId, siteId, jobId: j1.id, jobVersionId: j1.versionId, startTime: at(0), endTime: at(3.5), state: "UP", status: "UP", blockId: randomUUID() },
        { stationId, siteId, jobId: j1.id, jobVersionId: j1.versionId, startTime: at(3.5), state: "DOWN", status: "DOWN", blockId: randomUUID() },
      ],
    });
  });

  test("reassigns a closed window to J2 and leaves the rest as J1", async () => {
    const result = await amendJobHistory({ stationId, jobId: j2.id, from: at(2.5), to: at(4.5) });
    if ("error" in result) throw new Error(result.error);
    expect(result.data.summary).toMatchObject({ cycles: 2, itemsRemoved: 2, itemsCreated: 2, stateRows: 2 });

    const logs = await prisma.stationJobLog.findMany({ where: { stationId }, orderBy: { startTime: "asc" } });
    expect(logs.map((l) => [l.jobId, l.startTime.getTime(), l.endTime?.getTime() ?? null])).toEqual([
      [j1.id, at(0).getTime(), at(2.5).getTime()],
      [j2.id, at(2.5).getTime(), at(4.5).getTime()],
      [j1.id, at(4.5).getTime(), null],
    ]);

    const cycles = await prisma.cycle.findMany({ where: { stationId }, orderBy: { end: "asc" } });
    expect(cycles.map((c) => c.jobVersionId)).toEqual([j1.versionId, j1.versionId, j2.versionId, j2.versionId, j1.versionId]);

    const live = await prisma.inventoryItem.findMany({ where: { stationId, deletedAt: null }, orderBy: { createdAt: "asc" } });
    expect(live.map((i) => i.productId).sort()).toEqual([j1.productId, j1.productId, j1.productId, j2.productId, j2.productId].sort());
    expect(await prisma.inventoryItem.count({ where: { stationId, deletedAt: { not: null } } })).toBe(2);

    const states = await prisma.stationStateLog.findMany({ where: { stationId, deletedAt: null }, orderBy: { startTime: "asc" } });
    expect(states.map((s) => [s.status, s.jobId, s.startTime.getTime()])).toEqual([
      ["UP", j1.id, at(0).getTime()],
      ["UP", j2.id, at(2.5).getTime()],
      ["DOWN", j2.id, at(3.5).getTime()],
      ["DOWN", j1.id, at(4.5).getTime()],
    ]);

    const amendment = await prisma.jobHistoryAmendment.findFirstOrThrow({ where: { stationId } });
    expect(amendment.status).toBe("PENDING_REBUILD");
    expect(amendment.previousTimeline).toHaveLength(1);
  });

  test("rejects windows that are not in the past or that exceed the bound", async () => {
    expect(await amendJobHistory({ stationId, jobId: j2.id, from: at(5), to: at(4) })).toMatchObject({ code: "INVALID_RANGE" });
    expect(
      await amendJobHistory({ stationId, jobId: j2.id, from: new Date(t0.getTime() - 10 * 24 * hour), to: at(1) }),
    ).toMatchObject({ code: "RANGE_TOO_LARGE" });
  });

  test("an open-ended window becomes the current job", async () => {
    const result = await amendJobHistory({ stationId, jobId: j2.id, from: at(5.5), to: null });
    if ("error" in result) throw new Error(result.error);
    expect(result.data.currentJobChanged).toBe(true);
    expect((await prisma.station.findUniqueOrThrow({ where: { id: stationId } })).currentJobId).toBe(j2.id);
    const open = await prisma.stationJobLog.findMany({ where: { stationId, endTime: null } });
    expect(open.map((l) => [l.jobId, l.startTime.getTime()])).toEqual([[j2.id, at(5.5).getTime()]]);
    const openState = await prisma.stationStateLog.findFirst({ where: { stationId, endTime: null, deletedAt: null } });
    expect(openState).toMatchObject({ status: "DOWN", jobId: j2.id, startTime: at(5.5) });
  });

  test("is idempotent: asserting the timeline that already exists changes nothing", async () => {
    const before = await prisma.stationJobLog.findMany({ where: { stationId }, orderBy: { startTime: "asc" } });
    const result = await amendJobHistory({ stationId, jobId: j2.id, from: at(2.5), to: at(4.5) });
    if ("error" in result) throw new Error(result.error);
    const after = await prisma.stationJobLog.findMany({ where: { stationId }, orderBy: { startTime: "asc" } });
    expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id));
    expect(result.data.summary).toMatchObject({ cycles: 2, itemsRemoved: 2, itemsCreated: 2 });
  });
});
