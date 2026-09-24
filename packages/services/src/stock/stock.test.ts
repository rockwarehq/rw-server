import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma, { ensureAccountWorkspace } from "@rw/db";
import { remove as removeScrap, update as updateScrap } from "../inventory/disposition-log.js";
import { getStock } from "../inventory/stock.js";
import * as orders from "../order/order.js";
import { lockProductBalances, rebuildProductBalances } from "./balance.js";
import { stockFixture } from "./fixtures.js";
import { postSources, reverseSources } from "./post.js";
import { isClean, reconcileProductStock } from "./reconcile.js";

// Integration tests: require DATABASE_URL and run against the real schema
// with an isolated fixture graph (same conventions as inventory-first.test.ts).

describe.skipIf(!process.env.DATABASE_URL)("stock book", () => {
  let siteId: string;
  let fixture: Awaited<ReturnType<typeof stockFixture>>;

  const newProduct = async () => (await prisma.product.create({ data: { siteId } })).id;
  const movementsOf = (sourceId: string) =>
    prisma.stockMovement.findMany({ where: { sourceId }, orderBy: { seq: "asc" } });

  beforeAll(async () => {
    const workspace = await ensureAccountWorkspace({ name: "Test Account", slug: "test-account" });
    siteId = (await prisma.site.create({ data: { name: `Stock Site ${randomUUID()}`, workspaceId: workspace.id } })).id;
    fixture = await stockFixture(siteId);
  });

  test("a bare product gets its StockItem the first time it moves", async () => {
    const productId = await newProduct();
    expect(await prisma.stockItem.findFirst({ where: { stockableId: productId } })).toBeNull();

    await fixture.produce(productId, 4);

    const item = await prisma.stockItem.findFirstOrThrow({ where: { stockableId: productId } });
    expect(item).toMatchObject({ stockableType: "PRODUCT", siteId, trackingMode: "NONE" });
    const stock = await getStock(prisma, siteId, [productId]);
    expect(stock.get(productId)).toMatchObject({ produced: 4, available: 4 });
  });

  test("posting the same record twice counts it once", async () => {
    const productId = await newProduct();
    const itemId = await fixture.produce(productId, 2);

    await prisma.$transaction((tx) => postSources(tx, [{ type: "INVENTORY_ITEM", ids: [itemId] }]));

    const movements = await movementsOf(itemId);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ kind: "OUTPUT", idempotencyKey: `INVENTORY_ITEM:${itemId}` });
    expect((await getStock(prisma, siteId, [productId])).get(productId)?.produced).toBe(2);
  });

  test("changing and removing a scrap entry cancels and re-posts, never edits", async () => {
    const productId = await newProduct();
    await fixture.produce(productId, 10);
    const logId = await fixture.scrap(productId, 2);

    const changed = await updateScrap(logId, { quantity: 3 });
    expect("error" in changed).toBe(false);
    expect((await getStock(prisma, siteId, [productId])).get(productId)).toMatchObject({ scrapped: 3, available: 7 });

    const removed = await removeScrap(logId);
    expect("error" in removed).toBe(false);

    const movements = await movementsOf(logId);
    expect(movements.map((m) => [m.kind, m.quantity.toNumber(), m.reversesMovementId !== null])).toEqual([
      ["SCRAP", -2, false],
      ["SCRAP", 2, true],
      ["SCRAP", -3, false],
      ["SCRAP", 3, true],
    ]);
    expect(movements[1].reversesMovementId).toBe(movements[0].id);
    expect(movements[2].idempotencyKey).toBe(`ITEM_DISPOSITION_LOG:${logId}:r1`);
    // A cancelling row keeps the time (and so the shift) of the row it cancels.
    expect(movements[1].occurredAt).toEqual(movements[0].occurredAt);
    expect((await getStock(prisma, siteId, [productId])).get(productId)).toMatchObject({ scrapped: 0, available: 10 });

    // Nothing left to cancel: a second cancel is a no-op.
    await prisma.$transaction((tx) => reverseSources(tx, [{ type: "ITEM_DISPOSITION_LOG", ids: [logId] }]));
    expect(await movementsOf(logId)).toHaveLength(4);
  });

  test("completing an order posts what it took", async () => {
    const productId = await newProduct();
    await fixture.produce(productId, 5);
    const order = await orders.create({
      siteId,
      orderNumber: `STK-${randomUUID().slice(0, 8)}`,
      lineItems: [{ productId, targetQuantity: 3 }],
    });
    if ("error" in order) throw new Error(order.error);

    const done = await orders.transitionStatus(order.data.id, "COMPLETED", {});
    expect("error" in done && done.error).toBeFalsy();

    const consumption = await prisma.orderConsumption.findFirstOrThrow({ where: { orderId: order.data.id } });
    const movements = await movementsOf(consumption.id);
    expect(movements.map((m) => [m.kind, m.quantity.toNumber()])).toEqual([["FULFILLMENT", -3]]);
    expect((await getStock(prisma, siteId, [productId])).get(productId)).toMatchObject({ consumed: 3, available: 2 });
  });

  test("saves that touch the same products in opposite order both finish", async () => {
    const a = await newProduct();
    const b = await newProduct();
    // Records made without posting, then posted by two saves at once.
    await fixture.produce(a, 1);
    await fixture.produce(b, 1);
    const [va, vb] = [await fixture.versionOf(a), await fixture.versionOf(b)];
    const cycle = await prisma.cycle.findFirstOrThrow({ where: { siteId } });
    const make = (productId: string, productVersionId: string) =>
      prisma.inventoryItem.create({ data: { cycleId: cycle.id, siteId, productId, productVersionId, quantity: 1 } });
    const items = await Promise.all([make(a, va), make(b, vb), make(b, vb), make(a, va)]);

    await Promise.all([
      prisma.$transaction(async (tx) => {
        await lockProductBalances(tx, siteId, [a, b]);
        await postSources(tx, [{ type: "INVENTORY_ITEM", ids: [items[0].id, items[1].id] }]);
      }),
      prisma.$transaction(async (tx) => {
        await lockProductBalances(tx, siteId, [b, a]);
        await postSources(tx, [{ type: "INVENTORY_ITEM", ids: [items[2].id, items[3].id] }]);
      }),
    ]);

    // One from each fixture cycle, two more from each save.
    const stock = await getStock(prisma, siteId, [a, b]);
    expect(stock.get(a)?.produced).toBe(3);
    expect(stock.get(b)?.produced).toBe(3);
  });

  test("the repair job finds a record the book missed, fixes it, and is then clean", async () => {
    const productId = await newProduct();
    const itemId = await fixture.produce(productId, 6);
    // Delete the made part behind the book's back (as old code would have).
    await prisma.inventoryItem.update({ where: { id: itemId }, data: { deletedAt: new Date() } });

    const check = await reconcileProductStock({ siteId });
    expect(check.mismatched.INVENTORY_ITEM).toBe(1);
    expect(isClean(check)).toBe(false);

    await reconcileProductStock({ siteId, repair: true });
    expect(isClean(await reconcileProductStock({ siteId }))).toBe(true);
    expect((await getStock(prisma, siteId, [productId])).get(productId)?.produced).toBe(0);
    const movements = await movementsOf(itemId);
    expect(movements.map((m) => [m.quantity.toNumber(), m.note])).toEqual([
      [6, null],
      [-6, "Stock repair"],
    ]);
  });

  test("rebuilding the totals from the book changes nothing", async () => {
    const before = await prisma.stockBalance.findMany({ where: { siteId }, orderBy: { stockItemId: "asc" } });
    await rebuildProductBalances(siteId);
    const after = await prisma.stockBalance.findMany({ where: { siteId }, orderBy: { stockItemId: "asc" } });
    const strip = (rows: typeof before) => rows.map(({ updatedAt: _, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
  });
});
