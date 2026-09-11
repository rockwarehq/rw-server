import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import { reassignItems } from "./amend.js";
import { createFromCycle } from "./inventory.js";
import { flushShiftUsage } from "./material-shift-flush.js";

// Integration test: requires DATABASE_URL. One cycle of J1 (product uses 2 KG of M)
// in a shift whose usage was flushed; amending it to J2 (3 KG of M) must post the
// 1 KG difference as an ADJUSTMENT rather than touch the flushed PRODUCTION row.

describe.skipIf(!process.env.DATABASE_URL)("reassignItems ledger adjustment", () => {
  let siteId: string;
  let stationId: string;
  let shiftId: string;
  let materialId: string;
  let cycleId: string;
  let amendmentId: string;
  let j1: { id: string; versionId: string };
  let j2: { id: string; versionId: string };
  const hour = 60 * 60 * 1000;
  const start = new Date(Date.now() - 10 * hour);

  async function makeJob(name: string, weightKg: number) {
    const product = await prisma.product.create({ data: { siteId } });
    const pv = await prisma.productVersion.create({ data: { productId: product.id, version: 1, sku: name } });
    await prisma.product.update({ where: { id: product.id }, data: { currentVersionId: pv.id } });
    const mv = await prisma.materialVersion.findFirstOrThrow({ where: { materialId } });
    const pm = await prisma.productMaterial.create({ data: { productId: product.id, materialId } });
    const pmv = await prisma.productMaterialVersion.create({
      data: {
        productMaterialId: pm.id,
        version: 1,
        weight: weightKg,
        weightUnits: "KG",
        materialVersionId: mv.id,
        productVersionId: pv.id,
      },
    });
    await prisma.productMaterial.update({ where: { id: pm.id }, data: { currentVersionId: pmv.id } });
    const job = await prisma.job.create({ data: { siteId } });
    const jv = await prisma.jobVersion.create({ data: { jobId: job.id, version: 1, name } });
    await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: jv.id } });
    const jp = await prisma.jobProduct.create({ data: { jobId: job.id, productId: product.id } });
    const jpv = await prisma.jobProductVersion.create({ data: { jobProductId: jp.id, version: 1, quantity: 1 } });
    await prisma.jobProduct.update({ where: { id: jp.id }, data: { currentVersionId: jpv.id } });
    return { id: job.id, versionId: jv.id };
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({ data: { name: `Ledger ${suffix}`, slug: `ledger-${suffix}` } });
    siteId = (await prisma.site.create({ data: { name: `Ledger Site ${suffix}`, workspaceId: workspace.id } })).id;
    const pattern = await prisma.shiftPattern.create({ data: { siteId, name: "P" } });
    const definition = await prisma.shiftDefinition.create({
      data: {
        patternId: pattern.id,
        dayOfRotation: 1,
        sortOrder: 1,
        startTime: "06:00",
        durationHrs: 8,
        shiftName: "S",
      },
    });
    const assignment = await prisma.shiftAssignment.create({
      data: { patternId: pattern.id, siteId, rotationStartDate: start },
    });
    shiftId = (
      await prisma.shiftInstance.create({
        data: {
          assignmentId: assignment.id,
          definitionId: definition.id,
          siteId,
          shiftName: "S",
          businessDate: start,
          startTime: start,
          endTime: new Date(start.getTime() + 8 * hour),
        },
      })
    ).id;
    const material = await prisma.material.create({ data: { siteId } });
    materialId = material.id;
    const mv = await prisma.materialVersion.create({
      data: { materialId, version: 1, materialNumber: "M", weightUnits: "KG" },
    });
    await prisma.material.update({ where: { id: materialId }, data: { currentVersionId: mv.id } });
    j1 = await makeJob("J1", 2);
    j2 = await makeJob("J2", 3);
    stationId = (await prisma.station.create({ data: { siteId, name: "Press", currentJobId: j1.id } })).id;

    const dims = { siteId, stationId, workcenterId: null, jobId: j1.id, shiftInstanceId: shiftId, businessDate: start };
    await prisma.$transaction(async (tx) => {
      const cycle = await tx.cycle.create({
        data: {
          jobVersionId: j1.versionId,
          start,
          end: new Date(start.getTime() + hour),
          cycleStatus: "GOOD",
          ...dims,
        },
      });
      cycleId = cycle.id;
      await createFromCycle(tx, cycle.id, j1.id, undefined, null, dims);
    });
    await flushShiftUsage(shiftId);
    amendmentId = (
      await prisma.jobHistoryAmendment.create({
        data: {
          siteId,
          stationId,
          jobId: j2.id,
          jobVersionId: j2.versionId,
          fromTime: start,
          toTime: new Date(start.getTime() + 2 * hour),
          previousTimeline: [],
        },
      })
    ).id;
  });

  test("posts the material difference as one ADJUSTMENT stamped with the flushed shift", async () => {
    const summary = await prisma.$transaction((tx) =>
      reassignItems(
        {
          tx,
          amendmentId,
          siteId,
          stationId,
          workcenterId: null,
          from: start,
          toEff: new Date(start.getTime() + 2 * hour),
          job: { id: j2.id, versionId: j2.versionId, standardCycle: null, standardQuantity: null, quantityUnit: "PCS" },
        },
        [cycleId],
      ),
    );
    expect(summary).toMatchObject({ itemsRemoved: 1, itemsCreated: 1, ledgerAdjustments: 1 });

    const ledger = await prisma.materialLedgerEntry.findMany({ where: { materialId }, orderBy: { createdAt: "asc" } });
    expect(ledger.map((e) => [e.kind, e.quantity.toNumber(), e.unit, e.shiftInstanceId, e.reference])).toEqual([
      ["PRODUCTION", -2, "KG", shiftId, null],
      ["ADJUSTMENT", -1, "KG", shiftId, amendmentId],
    ]);
    // Staging stays the audit record of the original flush.
    const staging = await prisma.materialShiftUsage.findMany({ where: { shiftInstanceId: shiftId } });
    expect(staging.map((r) => [r.jobId, r.quantity.toNumber(), r.flushedAt !== null])).toEqual([[j1.id, 2, true]]);
  });
});
