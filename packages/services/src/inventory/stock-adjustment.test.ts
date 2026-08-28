import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import * as orders from "../order/order.js";
import { checkAutoComplete } from "../order/auto-complete.js";
import { adjustStock, list } from "./stock-adjustment.js";
import { applyProduction, applyScrapDelta, getStock, rederiveProductStock } from "./stock.js";

// Integration tests (inventory-first.test.ts conventions): require
// DATABASE_URL and run against the real schema with an isolated fixture graph.

describe.skipIf(!process.env.DATABASE_URL)("stock adjustments", () => {
  let siteId: string;
  let otherSiteId: string;
  let userId: string;
  let productA: string;
  let productB: string;

  async function produce(productId: string, quantity: number) {
    await prisma.$transaction(async (tx) => {
      await applyProduction(tx, siteId, [{ productId, quantity }]);
    });
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({
      data: { name: `StockAdj Test ${suffix}`, slug: `stock-adj-${suffix}` },
    });
    siteId = (await prisma.site.create({ data: { name: `StockAdj Site ${suffix}`, workspaceId: workspace.id } })).id;
    otherSiteId = (
      await prisma.site.create({ data: { name: `StockAdj Other ${suffix}`, workspaceId: workspace.id } })
    ).id;
    userId = (
      await prisma.user.create({
        data: { email: `adjuster-${suffix}@test.local`, passwordHash: "x", firstName: "Adj", lastName: "User" },
      })
    ).id;
    productA = (await prisma.product.create({ data: { siteId } })).id;
    productB = (await prisma.product.create({ data: { siteId } })).id;
  });

  test("delta mode accumulates signed corrections into the aggregate", async () => {
    const up = await adjustStock({
      siteId,
      productId: productA,
      mode: "delta",
      delta: 10,
      reason: "FOUND",
      performedByUserId: userId,
    });
    expect("error" in up && up.error).toBeFalsy();

    const down = await adjustStock({ siteId, productId: productA, mode: "delta", delta: -4, reason: "DAMAGE" });
    expect("error" in down && down.error).toBeFalsy();

    const stock = await getStock(prisma, siteId, [productA]);
    expect(stock.get(productA)).toMatchObject({ adjustment: 6, available: 6 });

    const history = await list({ siteId, productId: productA });
    expect(history.total).toBe(2);
    // Newest first
    expect(Number(history.data[0].delta)).toBe(-4);
    expect(Number(history.data[0].resultingOnHand)).toBe(6);
    expect(Number(history.data[1].delta)).toBe(10);
    expect(Number(history.data[1].resultingOnHand)).toBe(10);
    expect(history.data[1].performedByUser).toMatchObject({ email: expect.stringContaining("adjuster-") });
  });

  test("set mode lands exactly on the counted value, even from negative raw on-hand", async () => {
    // produced 5, scrapped 8 → raw −3, clamped available 0
    await produce(productB, 5);
    await applyScrapDelta(prisma, siteId, productB, 8);
    const before = await getStock(prisma, siteId, [productB]);
    expect(before.get(productB)).toMatchObject({ available: 0 });

    const result = await adjustStock({
      siteId,
      productId: productB,
      mode: "set",
      countedQuantity: 10,
      reason: "CYCLE_COUNT",
      note: "shelf count",
    });
    expect("error" in result && result.error).toBeFalsy();

    const after = await getStock(prisma, siteId, [productB]);
    expect(after.get(productB)).toMatchObject({ adjustment: 13, available: 10 });

    const history = await list({ siteId, productId: productB });
    expect(Number(history.data[0].delta)).toBe(13);
    expect(Number(history.data[0].resultingOnHand)).toBe(10);
  });

  test("zero-delta count is recorded; zero delta and negative counts are rejected", async () => {
    const productC = (await prisma.product.create({ data: { siteId } })).id;

    // Set mode on a product with NO ProductStock row yet: creates the row.
    const confirming = await adjustStock({
      siteId,
      productId: productC,
      mode: "set",
      countedQuantity: 0,
      reason: "CYCLE_COUNT",
    });
    expect("error" in confirming && confirming.error).toBeFalsy();
    const history = await list({ siteId, productId: productC });
    expect(history.total).toBe(1);
    expect(Number(history.data[0].delta)).toBe(0);

    const zeroDelta = await adjustStock({ siteId, productId: productC, mode: "delta", delta: 0, reason: "OTHER" });
    expect("code" in zeroDelta && zeroDelta.code).toBe("INVALID_QUANTITY");

    const negativeCount = await adjustStock({
      siteId,
      productId: productC,
      mode: "set",
      countedQuantity: -1,
      reason: "CYCLE_COUNT",
    });
    expect("code" in negativeCount && negativeCount.code).toBe("INVALID_QUANTITY");
  });

  test("rejects products outside the given site", async () => {
    const foreign = (await prisma.product.create({ data: { siteId: otherSiteId } })).id;
    const result = await adjustStock({ siteId, productId: foreign, mode: "delta", delta: 1, reason: "OTHER" });
    expect("code" in result && result.code).toBe("SITE_MISMATCH");
  });

  test("rederive recomputes adjustment from the ledger (fact-backed), and zeroes orphans", async () => {
    // Corrupt the aggregate out-of-band, then rebuild.
    await prisma.productStock.update({
      where: { siteId_productId: { siteId, productId: productA } },
      data: { adjustment: 999 },
    });
    await rederiveProductStock(siteId);
    const stock = await getStock(prisma, siteId, [productA, productB]);
    expect(stock.get(productA)?.adjustment).toBe(6); // SUM(+10, −4)
    expect(stock.get(productB)?.adjustment).toBe(13);

    // Idempotent
    await rederiveProductStock(siteId);
    const again = await getStock(prisma, siteId, [productA, productB]);
    expect(again.get(productA)).toEqual(stock.get(productA));
  });

  test("an upward adjustment auto-completes a newly covered order when the site rule is on", async () => {
    const productD = (await prisma.product.create({ data: { siteId } })).id;
    const order = await orders.create({
      siteId,
      orderNumber: `ADJ-${randomUUID().slice(0, 8)}`,
      status: "OPEN",
      lineItems: [{ productId: productD, targetQuantity: 5 }],
    });
    if ("error" in order) throw new Error(order.error);

    await prisma.site.update({ where: { id: siteId }, data: { attrs: { orderAutoComplete: true } } });
    const result = await adjustStock({
      siteId,
      productId: productD,
      mode: "set",
      countedQuantity: 5,
      reason: "INITIAL",
    });
    expect("error" in result && result.error).toBeFalsy();
    // adjustStock fires checkAutoComplete fire-and-forget; await it directly
    // for determinism (same approach as the inventory-first suite).
    await checkAutoComplete(siteId, [productD]);

    const completed = await orders.get(order.data.id);
    expect(completed.data?.status).toBe("COMPLETED");
    const consumption = await prisma.orderConsumption.findFirst({ where: { orderId: order.data.id } });
    expect(consumption?.source).toBe("AUTO");

    await prisma.site.update({ where: { id: siteId }, data: { attrs: {} } });
  });
});
