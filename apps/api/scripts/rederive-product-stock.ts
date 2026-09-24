import "dotenv/config";
import prisma from "@rw/db";
import { isClean, reconcileProductStock } from "@rw/services/stock/reconcile";

// Check the stock book (StockMovement, ADR-0016) against the records it comes
// from — made parts, scrap, completed orders, counts — fix anything that
// disagrees, and rebuild the totals (StockBalance). Safe to run any time.
//
// Run it once after the stock_ledger deploy settles: servers still running
// the old code during the rollout saved records without posting them to the
// book, and this posts them. Also run it any time stock looks wrong.
//
// Usage:
//   pnpm exec tsx apps/api/scripts/rederive-product-stock.ts [siteId] [--check]
//
// Without a siteId, all sites are checked. --check reports without fixing.

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const siteId = args.find((a) => !a.startsWith("--"));

  const report = await reconcileProductStock({ siteId, repair: !check });
  const where = siteId ? `site ${siteId}` : "all sites";
  console.log(`Stock book ${check ? "checked" : "repaired"} (${where}):`);
  for (const [type, count] of Object.entries(report.mismatched)) {
    console.log(`  ${type}: ${count} record(s) ${check ? "disagree" : "fixed"}`);
  }
  console.log(`  movements whose record is gone: ${report.movementsWithoutSource} (kept)`);
  console.log(`  stock items with no product or material: ${report.stockItemsWithoutStockable}`);
  if (check && !isClean(report)) process.exitCode = 2;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
