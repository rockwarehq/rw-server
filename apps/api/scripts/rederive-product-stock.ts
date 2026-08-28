import "dotenv/config";
import prisma from "@rw/db";
import { rederiveProductStock } from "@rw/services/inventory/stock";

// Rebuild the ProductStock aggregate from facts (InventoryItem,
// ItemDispositionLog, OrderConsumption). Idempotent. Run once after the
// inventory-first cutover deploy settles (covers cycles closed by old pods
// between the migration backfill and full rollout), or any time stock is
// suspected to have drifted.
//
// Usage:
//   pnpm exec tsx apps/api/scripts/rederive-product-stock.ts [siteId]
//
// Without a siteId, all sites are rebuilt.

async function main() {
  const [siteId] = process.argv.slice(2);
  await rederiveProductStock(siteId || undefined);
  const where = siteId ? { siteId } : {};
  const count = await prisma.productStock.count({ where });
  console.log(`ProductStock re-derived (${siteId ? `site ${siteId}` : "all sites"}): ${count} rows.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
