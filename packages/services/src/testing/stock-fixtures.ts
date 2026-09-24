import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { postSources } from "../stock/post.js";

// ============================================================================
// Test helpers: real made-part and scrap records, posted to the stock book
// ============================================================================
//
// For tests only. This folder is not in the package's "exports", so app code
// cannot import it.
//
// Stock only moves when a record behind it exists, so tests make those
// records (a cycle with a made part, a scrap entry) instead of writing to
// the totals directly.

export async function stockFixture(siteId: string) {
  const station = await prisma.station.create({ data: { siteId, name: `Stock fixture ${randomUUID()}` } });
  const job = await prisma.job.create({ data: { siteId } });
  const jobVersion = await prisma.jobVersion.create({ data: { jobId: job.id, version: 1, name: "Stock fixture" } });
  await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: jobVersion.id } });

  /** The product's current version, made if the test built a bare product. */
  async function versionOf(productId: string): Promise<string> {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    if (product.currentVersionId) return product.currentVersionId;
    const version = await prisma.productVersion.create({
      data: { productId, version: 1, sku: `P-${productId.slice(0, 8)}` },
    });
    await prisma.product.update({ where: { id: productId }, data: { currentVersionId: version.id } });
    return version.id;
  }

  /** One cycle that made `quantity` of the product. Returns the InventoryItem id. */
  async function produce(productId: string, quantity: number): Promise<string> {
    const productVersionId = await versionOf(productId);
    return prisma.$transaction(async (tx) => {
      const cycle = await tx.cycle.create({
        data: { siteId, stationId: station.id, jobVersionId: jobVersion.id, start: new Date(), cycleStatus: "GOOD" },
      });
      const item = await tx.inventoryItem.create({
        data: { cycleId: cycle.id, siteId, stationId: station.id, productId, productVersionId, quantity },
      });
      await postSources(tx, [{ type: "INVENTORY_ITEM", ids: [item.id] }]);
      return item.id;
    });
  }

  /** A scrap entry of `quantity`. Returns the ItemDispositionLog id. */
  async function scrap(productId: string, quantity: number): Promise<string> {
    const productVersionId = await versionOf(productId);
    return prisma.$transaction(async (tx) => {
      const log = await tx.itemDispositionLog.create({
        data: { siteId, stationId: station.id, productId, productVersionId, quantity },
      });
      await postSources(tx, [{ type: "ITEM_DISPOSITION_LOG", ids: [log.id] }]);
      return log.id;
    });
  }

  return { stationId: station.id, produce, scrap, versionOf };
}
