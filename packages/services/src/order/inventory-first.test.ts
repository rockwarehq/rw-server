import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma, { ensureAccountWorkspace } from "@rw/db";
import { remove as removeScrap } from "../inventory/disposition-log.js";
import { getStock, rederiveProductStock } from "../inventory/stock.js";
import { stockFixture } from "../stock/fixtures.js";
import { checkAutoComplete } from "./auto-complete.js";
import { computeCoverage, getProductStockSummary } from "./coverage.js";
import * as orders from "./order.js";

// Integration tests (saved-view/document conventions): require DATABASE_URL
// and run against the real schema with an isolated fixture graph per suite.

describe.skipIf(!process.env.DATABASE_URL)("inventory-first orders", () => {
  let siteId: string;
  let otherSiteId: string;
  let productA: string;
  let productB: string;
  let orderNo = 0;
  let fixture: Awaited<ReturnType<typeof stockFixture>>;

  const nextOrderNumber = () => `TST-${String(++orderNo).padStart(3, "0")}`;

  async function createOpenOrder(lineItems: Array<{ productId: string; targetQuantity: number }>) {
    const result = await orders.create({
      siteId,
      orderNumber: nextOrderNumber(),
      lineItems,
    });
    if ("error" in result) throw new Error(`fixture order create failed: ${result.error}`);
    return result.data;
  }

  const produce = (productId: string, quantity: number) => fixture.produce(productId, quantity);

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await ensureAccountWorkspace({ name: "Test Account", slug: "test-account" });
    const site = await prisma.site.create({ data: { name: `InvFirst Site ${suffix}`, workspaceId: workspace.id } });
    siteId = site.id;
    const otherSite = await prisma.site.create({
      data: { name: `InvFirst Other ${suffix}`, workspaceId: workspace.id },
    });
    otherSiteId = otherSite.id;

    productA = (await prisma.product.create({ data: { siteId } })).id;
    productB = (await prisma.product.create({ data: { siteId } })).id;
    fixture = await stockFixture(siteId);
  });

  test("made parts accumulate per product; getStock defaults to zero", async () => {
    const before = await getStock(prisma, siteId, [productA]);
    expect(before.get(productA)).toMatchObject({ produced: 0, available: 0 });

    await produce(productA, 3);
    await produce(productA, 2);
    await produce(productB, 1);

    const after = await getStock(prisma, siteId, [productA, productB]);
    expect(after.get(productA)).toMatchObject({ produced: 5, available: 5 });
    expect(after.get(productB)).toMatchObject({ produced: 1, available: 1 });
  });

  test("scrap reduces availability and clamps at zero; removing it gives the stock back", async () => {
    const logId = await fixture.scrap(productB, 5);
    const stock = await getStock(prisma, siteId, [productB]);
    expect(stock.get(productB)).toMatchObject({ produced: 1, scrapped: 5, available: 0 });

    const removed = await removeScrap(logId);
    expect("error" in removed).toBe(false);
    const reverted = await getStock(prisma, siteId, [productB]);
    expect(reverted.get(productB)).toMatchObject({ scrapped: 0, available: 1 });
  });

  test("coverage walks the queue FIFO by sequence", async () => {
    // productA available: 5 (from earlier test)
    const first = await createOpenOrder([{ productId: productA, targetQuantity: 4 }]);
    const second = await createOpenOrder([{ productId: productA, targetQuantity: 4 }]);

    const coverage = await computeCoverage(siteId, [productA]);
    const firstLine = coverage.byLineItem.get(first.lineItems[0].id);
    const secondLine = coverage.byLineItem.get(second.lineItems[0].id);
    expect(firstLine).toMatchObject({ coveredQuantity: 4, remainingQuantity: 0 });
    expect(secondLine).toMatchObject({ coveredQuantity: 1, remainingQuantity: 3 });
    expect(coverage.openDemand.get(productA)).toBe(8);
    expect(coverage.coveredDemand.get(productA)).toBe(5);

    // list/get attach the same numbers
    const listed = await orders.list({ siteId, status: ["OPEN"] });
    const listedFirst = listed.data.find((o) => o.id === first.id);
    const listedSecond = listed.data.find((o) => o.id === second.id);
    expect(listedFirst?.isFullyCovered).toBe(true);
    expect(listedFirst?.coveragePct).toBe(100);
    expect(listedSecond?.isFullyCovered).toBe(false);
    expect(listedSecond?.lineItems[0].coveredQuantity).toBe(1);

    // Reorder flips priority: second now gets the stock first
    const flip = await orders.reorder(siteId, [second.id, first.id]);
    expect("error" in flip && flip.error).toBeFalsy();
    const flipped = await computeCoverage(siteId, [productA]);
    expect(flipped.byLineItem.get(second.lineItems[0].id)).toMatchObject({ coveredQuantity: 4 });
    expect(flipped.byLineItem.get(first.lineItems[0].id)).toMatchObject({ coveredQuantity: 1 });
    // restore original order for later tests
    await orders.reorder(siteId, [first.id, second.id]);
  });

  test("completing a fully covered order consumes stock and records consumption", async () => {
    const listed = await orders.list({ siteId, status: ["OPEN"] });
    const target = listed.data.find((o) => o.isFullyCovered);
    expect(target).toBeTruthy();
    if (!target) return;

    const result = await orders.transitionStatus(target.id, "COMPLETED", { source: "MANUAL" });
    expect("error" in result && result.error).toBeFalsy();

    const stock = await getStock(prisma, siteId, [productA]);
    expect(stock.get(productA)).toMatchObject({ consumed: 4, available: 1 });

    const consumptions = await prisma.orderConsumption.findMany({ where: { orderId: target.id } });
    expect(consumptions).toHaveLength(1);
    expect(Number(consumptions[0].quantity)).toBe(4);
    expect(consumptions[0].source).toBe("MANUAL");

    // completedAt is stamped in the same transaction as the ledger, so the
    // two can never disagree about when the order closed.
    const closed = await prisma.order.findUniqueOrThrow({ where: { id: target.id } });
    expect(closed.completedAt).not.toBeNull();
    expect(closed.cancelledAt).toBeNull();
    expect(Math.abs(closed.completedAt!.getTime() - consumptions[0].createdAt.getTime())).toBeLessThan(5000);

    // COMPLETED is terminal — a second complete is rejected.
    const again = await orders.transitionStatus(target.id, "COMPLETED", {});
    expect("code" in again && again.code).toBe("INVALID_TRANSITION");
  });

  test("partial coverage requires allowPartial and consumes only what is available", async () => {
    // Remaining open order wants 4, only 1 available.
    const listed = await orders.list({ siteId, status: ["OPEN"] });
    const short = listed.data.find((o) => o.lineItems.some((li) => li.productId === productA));
    expect(short).toBeTruthy();
    if (!short) return;

    const refused = await orders.transitionStatus(short.id, "COMPLETED", {});
    expect("code" in refused && refused.code).toBe("PARTIAL_COVERAGE");

    const allowed = await orders.transitionStatus(short.id, "COMPLETED", { allowPartial: true });
    expect("error" in allowed && allowed.error).toBeFalsy();

    const stock = await getStock(prisma, siteId, [productA]);
    expect(stock.get(productA)).toMatchObject({ consumed: 5, available: 0 });
    const consumptions = await prisma.orderConsumption.findMany({ where: { orderId: short.id } });
    expect(consumptions).toHaveLength(1);
    expect(Number(consumptions[0].quantity)).toBe(1);
  });

  test("cancelling consumes nothing", async () => {
    await produce(productB, 10);
    const order = await createOpenOrder([{ productId: productB, targetQuantity: 2 }]);
    const result = await orders.transitionStatus(order.id, "CANCELLED", {});
    expect("error" in result && result.error).toBeFalsy();
    expect(await prisma.orderConsumption.count({ where: { orderId: order.id } })).toBe(0);
    const stock = await getStock(prisma, siteId, [productB]);
    expect(stock.get(productB)?.consumed ?? 0).toBe(0);

    // Cancelled is closed too, and the two terminal stamps stay exclusive.
    const cancelled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.completedAt).toBeNull();
  });

  test("an order is born OPEN, stamped and sequenced", async () => {
    const born = await createOpenOrder([]);
    expect(born.status).toBe("OPEN");
    expect(born.openedAt).not.toBeNull();
    // It is in the fill queue from the moment it exists.
    expect(born.sequence).not.toBeNull();

    // The next one lands behind it.
    const next = await createOpenOrder([]);
    expect(next.sequence).toBeGreaterThan(born.sequence ?? 0);
  });

  test("the lifecycle has exactly two exits, both terminal", async () => {
    const order = await createOpenOrder([]);
    // OPEN is the only live status; there is nowhere sideways to go.
    for (const target of ["OPEN", "IN_PROGRESS", "ON_HOLD", "DRAFT"] as const) {
      const refused = await orders.transitionStatus(order.id, target as never, {});
      expect("code" in refused && refused.code).toBe("INVALID_TRANSITION");
    }

    const cancelled = await orders.transitionStatus(order.id, "CANCELLED", {});
    expect("error" in cancelled && cancelled.error).toBeFalsy();
    // And terminal means terminal — no reopening, no completing after the fact.
    for (const target of ["OPEN", "COMPLETED"] as const) {
      const after = await orders.transitionStatus(order.id, target as never, {});
      expect("code" in after && after.code).toBe("INVALID_TRANSITION");
    }
  });

  test("completing out of queue order needs the same confirmation as completing short", async () => {
    // Fresh product so the queue is exactly these two orders.
    const productC = (await prisma.product.create({ data: { siteId } })).id;
    await produce(productC, 5);

    const first = await createOpenOrder([{ productId: productC, targetQuantity: 5 }]);
    const second = await createOpenOrder([{ productId: productC, targetQuantity: 4 }]);

    // FIFO gives everything to the first: the second shows as uncovered.
    const coverage = await computeCoverage(siteId, [productC]);
    expect(coverage.byLineItem.get(first.lineItems[0].id)).toMatchObject({ coveredQuantity: 5 });
    expect(coverage.byLineItem.get(second.lineItems[0].id)).toMatchObject({ coveredQuantity: 0 });

    // Raw stock would let the second take 4, which is the first's. Refused
    // without an explicit allowPartial even though nothing is "short".
    const refused = await orders.transitionStatus(second.id, "COMPLETED", {});
    expect("code" in refused && refused.code).toBe("PARTIAL_COVERAGE");
    expect((await orders.get(second.id)).data?.status).toBe("OPEN");

    // Confirmed, it still wins — nothing is reserved, first to commit takes it.
    const confirmed = await orders.transitionStatus(second.id, "COMPLETED", { allowPartial: true });
    expect("error" in confirmed && confirmed.error).toBeFalsy();
    const stock = await getStock(prisma, siteId, [productC]);
    expect(stock.get(productC)).toMatchObject({ consumed: 4, available: 1 });

    // And the first order's coverage collapses, as it must.
    const after = await computeCoverage(siteId, [productC]);
    expect(after.byLineItem.get(first.lineItems[0].id)).toMatchObject({ coveredQuantity: 1 });
  });

  test("only a cancelled order can be deleted", async () => {
    const open = await createOpenOrder([]);
    const refusedOpen = await orders.remove(open.id);
    expect("code" in refusedOpen && refusedOpen.code).toBe("NOT_DELETABLE");

    await orders.transitionStatus(open.id, "CANCELLED", {});
    const removed = await orders.remove(open.id);
    expect("success" in removed && removed.success).toBe(true);
    const gone = await prisma.order.findUniqueOrThrow({ where: { id: open.id } });
    expect(gone.deletedAt).not.toBeNull();

    // A completed order consumed stock; it is never deletable.
    const completed = await createOpenOrder([]);
    await orders.transitionStatus(completed.id, "COMPLETED", {});
    const refusedDone = await orders.remove(completed.id);
    expect("code" in refusedDone && refusedDone.code).toBe("NOT_DELETABLE");
  });

  test("auto-complete completes fully covered orders in queue order, FIFO-strict", async () => {
    // Queue: first order short (target 20 > available), second fully covered on
    // a different product — only the second may auto-complete.
    const shortOrder = await createOpenOrder([{ productId: productA, targetQuantity: 20 }]);
    const coveredOrder = await createOpenOrder([{ productId: productB, targetQuantity: 3 }]);

    // Setting off: nothing happens.
    await checkAutoComplete(siteId, [productA, productB]);
    expect((await orders.get(coveredOrder.id)).data?.status).toBe("OPEN");

    await prisma.site.update({ where: { id: siteId }, data: { attrs: { orderAutoComplete: true } } });
    await checkAutoComplete(siteId, [productA, productB]);

    expect((await orders.get(coveredOrder.id)).data?.status).toBe("COMPLETED");
    expect((await orders.get(shortOrder.id)).data?.status).toBe("OPEN");
    const consumption = await prisma.orderConsumption.findFirst({ where: { orderId: coveredOrder.id } });
    expect(consumption?.source).toBe("AUTO");

    await prisma.site.update({ where: { id: siteId }, data: { attrs: {} } });
    await orders.transitionStatus(shortOrder.id, "CANCELLED", {});
  });

  test("reorder rejects ids outside the authorized site", async () => {
    const foreign = await orders.create({ siteId: otherSiteId, orderNumber: "FOREIGN-001" });
    if ("error" in foreign) throw new Error(foreign.error);
    const local = await createOpenOrder([{ productId: productB, targetQuantity: 1 }]);

    const result = await orders.reorder(siteId, [local.id, foreign.data.id]);
    expect("code" in result && result.code).toBe("ORDER_NOT_FOUND");
    // Foreign order's sequence untouched
    const foreignAfter = await prisma.order.findUnique({ where: { id: foreign.data.id }, select: { sequence: true } });
    expect(foreignAfter?.sequence).toBe(1);
    await orders.transitionStatus(local.id, "CANCELLED", {});
  });

  test("line items are editable until the order is terminal", async () => {
    const order = await createOpenOrder([{ productId: productA, targetQuantity: 1 }]);

    const added = await orders.addLineItem(order.id, { productId: productB, targetQuantity: 2 });
    expect("error" in added && added.error).toBeFalsy();
    if ("error" in added) return;

    const updated = await orders.updateLineItem(added.data.id, { targetQuantity: 3 });
    expect("error" in updated && updated.error).toBeFalsy();

    await orders.transitionStatus(order.id, "CANCELLED", {});
    const blocked = await orders.updateLineItem(added.data.id, { targetQuantity: 4 });
    expect("code" in blocked && blocked.code).toBe("NOT_EDITABLE");
    const blockedRemove = await orders.removeLineItem(added.data.id);
    expect("code" in blockedRemove && blockedRemove.code).toBe("NOT_EDITABLE");
  });

  test("rederiveProductStock finds nothing to fix and keeps every total", async () => {
    // Every movement in this suite came from a real record, so the check is
    // clean and the rebuild changes nothing.
    const before = await getStock(prisma, siteId, [productA, productB]);
    const report = await rederiveProductStock(siteId);
    expect(Object.values(report.mismatched).every((n) => n === 0)).toBe(true);
    const after = await getStock(prisma, siteId, [productA, productB]);
    expect(after.get(productA)).toEqual(before.get(productA));
    expect(after.get(productB)).toEqual(before.get(productB));

    await rederiveProductStock(siteId);
    const again = await getStock(prisma, siteId, [productA, productB]);
    expect(again.get(productA)).toEqual(after.get(productA));
    expect(again.get(productB)).toEqual(after.get(productB));
  });

  test("product stock summary combines stock with open demand", async () => {
    const summary = await getProductStockSummary(siteId, [productA]);
    const row = summary.data.find((r) => r.productId === productA);
    expect(row).toBeTruthy();
    expect(row?.openDemand).toBeGreaterThanOrEqual(0);
    expect(row?.coveredDemand).toBeLessThanOrEqual(row?.openDemand ?? 0);
  });
});
