import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma, { ensureAccountWorkspace, type WeightUnit } from "@rw/db";
import { balance } from "../inventory/material-balance.js";
import { adjust, create as createEntry } from "../inventory/material-ledger.js";
import { create as createMaterial, update as updateMaterial } from "../inventory/material.js";
import { flushShiftUsage } from "../inventory/material-shift-flush.js";
import { countOffBalances } from "./balance.js";
import { catchUpMaterialLedger, isClean, reconcileStock } from "./reconcile.js";

// Integration tests for materials on the stock book (ADR-0016 phase 2).
// Require DATABASE_URL, like the other stock tests.

describe.skipIf(!process.env.DATABASE_URL)("materials on the stock book", () => {
  let siteId: string;
  const hour = 60 * 60 * 1000;

  async function material(weightUnits: WeightUnit | null) {
    const made = await createMaterial({ siteId, materialNumber: `M-${randomUUID().slice(0, 8)}`, weightUnits });
    if ("error" in made) throw new Error(made.error);
    return made.data.id;
  }
  const stockItem = (materialId: string) =>
    prisma.stockItem.findFirstOrThrow({ where: { stockableType: "MATERIAL", stockableId: materialId } });
  const movementsOf = async (materialId: string) =>
    prisma.stockMovement.findMany({
      where: { stockItemId: (await stockItem(materialId)).id },
      orderBy: { seq: "asc" },
    });

  beforeAll(async () => {
    const workspace = await ensureAccountWorkspace({ name: "Test Account", slug: "test-account" });
    siteId = (await prisma.site.create({ data: { name: `MatStock ${randomUUID()}`, workspaceId: workspace.id } })).id;
  });

  test("an entry in another weight keeps its unit in the book and converts in the totals", async () => {
    const m = await material("KG");
    // 11.0231 LB = 5.0000012 KG, which rounds to 5 at the book's 4 places.
    const entry = await createEntry({ siteId, materialId: m, kind: "RECEIPT", quantity: "11.0231", unit: "LB" });
    expect("error" in entry).toBe(false);

    const [movement] = await movementsOf(m);
    expect(movement).toMatchObject({ kind: "RECEIPT", unit: "LB", sourceType: "MATERIAL_LEDGER_ENTRY" });
    expect(movement.quantity.toNumber()).toBe(11.0231);

    const b = await balance(m);
    expect(b.unit).toBe("KG");
    expect(b.received.toNumber()).toBe(5);
    expect(b.balance.toNumber()).toBe(5);
  });

  test("a not-tracked material refuses stock entries and counts", async () => {
    const m = await material(null);
    const entry = await createEntry({ siteId, materialId: m, kind: "RECEIPT", quantity: 5, unit: "KG" });
    expect("code" in entry && entry.code).toBe("NO_CANONICAL_UNIT");
    const count = await adjust({ siteId, materialId: m, mode: "set", countedQuantity: 1 });
    expect("code" in count && count.code).toBe("NO_CANONICAL_UNIT");
    expect(await movementsOf(m)).toHaveLength(0);
  });

  test("a not-tracked material on a live part's bill of materials is reported", async () => {
    const m = await material(null);
    const product = await prisma.product.create({ data: { siteId } });
    await prisma.productMaterial.create({ data: { productId: product.id, materialId: m } });
    const report = await reconcileStock({ siteId });
    expect(report.untrackedMaterialsInUse).toBeGreaterThanOrEqual(1);
  });

  test("changing between weights converts the totals; history keeps its units", async () => {
    const m = await material("KG");
    await createEntry({ siteId, materialId: m, kind: "RECEIPT", quantity: 10, unit: "KG" });

    const changed = await updateMaterial(m, { weightUnits: "LB" });
    expect("error" in changed).toBe(false);

    expect((await stockItem(m)).baseUnit).toBe("LB");
    const b = await balance(m);
    expect(b.unit).toBe("LB");
    expect(b.balance.toNumber()).toBe(22.0462);
    expect((await movementsOf(m)).map((x) => x.unit)).toEqual(["KG"]);
    expect(await countOffBalances({ siteId })).toBe(0);
  });

  test("a material with stock cannot stop being tracked; with none it can", async () => {
    const m = await material("KG");
    await createEntry({ siteId, materialId: m, kind: "RECEIPT", quantity: 3, unit: "KG" });
    const refused = await updateMaterial(m, { weightUnits: null });
    expect("code" in refused && refused.code).toBe("STOCK_ON_HAND");
    expect((await stockItem(m)).baseUnit).toBe("KG");

    await createEntry({ siteId, materialId: m, kind: "WRITE_OFF", quantity: -3, unit: "KG" });
    const allowed = await updateMaterial(m, { weightUnits: null });
    expect("error" in allowed).toBe(false);
    expect((await stockItem(m)).baseUnit).toBe("");
  });

  test("a not-tracked material starts tracking when it gets a unit", async () => {
    const m = await material(null);
    await updateMaterial(m, { weightUnits: "G" });
    const entry = await createEntry({ siteId, materialId: m, kind: "RECEIPT", quantity: 500, unit: "G" });
    expect("error" in entry).toBe(false);
    expect((await balance(m)).balance.toNumber()).toBe(500);
  });

  describe("shift usage", () => {
    let shiftId: string;
    let shiftStart: Date;
    let stationId: string;
    let jobId: string;
    let productId: string;

    beforeAll(async () => {
      shiftStart = new Date(Date.now() - 10 * hour);
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
        data: { patternId: pattern.id, siteId, rotationStartDate: shiftStart },
      });
      shiftId = (
        await prisma.shiftInstance.create({
          data: {
            assignmentId: assignment.id,
            definitionId: definition.id,
            siteId,
            shiftName: "S",
            businessDate: shiftStart,
            startTime: shiftStart,
            endTime: new Date(shiftStart.getTime() + 8 * hour),
            isScheduled: false,
          },
        })
      ).id;
      stationId = (await prisma.station.create({ data: { siteId, name: `Press ${randomUUID()}` } })).id;
      jobId = (await prisma.job.create({ data: { siteId } })).id;
      productId = (await prisma.product.create({ data: { siteId } })).id;
    });

    const stage = (materialId: string, quantity: number, unit: WeightUnit) =>
      prisma.materialShiftUsage.create({
        data: {
          siteId,
          shiftInstanceId: shiftId,
          stationId,
          jobId,
          productId,
          materialId,
          quantity,
          unit,
          itemCount: 1,
        },
      });

    test("open-shift usage counts against the balance before it is flushed", async () => {
      const m = await material("KG");
      await createEntry({ siteId, materialId: m, kind: "RECEIPT", quantity: 10, unit: "KG" });
      await stage(m, 2, "KG");
      const b = await balance(m);
      expect(b.balance.toNumber()).toBe(8);
      expect(b.consumed.toNumber()).toBe(2);
      // Not in the book yet.
      expect((await movementsOf(m)).map((x) => x.kind)).toEqual(["RECEIPT"]);
    });

    test("the flush posts USAGE placed at its shift's start, with the shift's labels", async () => {
      const m = await material("KG");
      await createEntry({ siteId, materialId: m, kind: "RECEIPT", quantity: 10, unit: "KG" });
      await stage(m, 3, "KG");

      await flushShiftUsage(shiftId);

      const usage = (await movementsOf(m)).find((x) => x.kind === "USAGE");
      expect(usage?.quantity.toNumber()).toBe(-3);
      expect(usage?.occurredAt).toEqual(shiftStart);
      expect(usage).toMatchObject({ shiftInstanceId: shiftId, isScheduled: false });
      const ledger = await prisma.materialLedgerEntry.findFirstOrThrow({
        where: { materialId: m, kind: "PRODUCTION" },
      });
      expect(ledger.isScheduled).toBe(false);

      const b = await balance(m);
      expect(b.balance.toNumber()).toBe(7);
      expect(b.consumed.toNumber()).toBe(3);
    });
  });

  test("the deploy catch-up posts a recent ledger row that has no movement", async () => {
    const m = await material("KG");
    await stockItem(m);
    // What an old server does: write the ledger row, never the book.
    await prisma.materialLedgerEntry.create({
      data: { siteId, materialId: m, kind: "RECEIPT", quantity: 4, unit: "KG" },
    });
    expect(await catchUpMaterialLedger({ siteId })).toBe(1);
    expect((await balance(m)).balance.toNumber()).toBe(4);
    expect(await catchUpMaterialLedger({ siteId })).toBe(0);
  });

  test("the repair job covers material totals and stock units", async () => {
    const m = await material("KG");
    await createEntry({ siteId, materialId: m, kind: "RECEIPT", quantity: 6, unit: "KG" });
    const item = await stockItem(m);
    // Totals drift, and a script edits the unit behind the stock item's back.
    await prisma.$executeRaw`
      UPDATE "StockBalance" SET received = 99, "onHand" = 99 WHERE "stockItemId" = ${item.id}::uuid
    `;
    const current = await prisma.material.findUniqueOrThrow({ where: { id: m } });
    await prisma.materialVersion.update({ where: { id: current.currentVersionId ?? "" }, data: { weightUnits: "G" } });

    const check = await reconcileStock({ siteId });
    expect(check.balancesOff).toBeGreaterThanOrEqual(1);
    expect(check.unitsOutOfStep).toBe(1);
    expect(isClean(check)).toBe(false);

    await reconcileStock({ siteId, repair: true });
    expect(isClean(await reconcileStock({ siteId }))).toBe(true);
    expect((await stockItem(m)).baseUnit).toBe("G");
    expect((await balance(m)).balance.toNumber()).toBe(6000);
  });
});
