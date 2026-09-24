import "dotenv/config";
import prisma from "@rw/db";
import { isClean, reconcileStock } from "@rw/services/stock/reconcile";

// Check the stock book (StockMovement, ADR-0016) against the records it comes
// from — made parts, scrap, completed orders, counts, and material ledger
// rows — fix anything that disagrees, and rebuild the totals (StockBalance).
// Safe to run any time.
//
// Not needed after a deploy: the workers catch up on records old servers
// saved during the rollout by themselves (catchUpAfterStockMigration,
// catchUpMaterialLedger). Run it
// any time stock looks wrong, or with --check to confirm the book is clean.
//
// Usage:
//   pnpm exec tsx apps/api/scripts/rederive-product-stock.ts [siteId] [--check]
//
// Without a siteId, all sites are checked. --check reports without fixing.

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const siteId = args.find((a) => !a.startsWith("--"));

  const report = await reconcileStock({ siteId, repair: !check });
  const where = siteId ? `site ${siteId}` : "all sites";
  console.log(`Stock book ${check ? "checked" : "repaired"} (${where}):`);
  for (const [type, count] of Object.entries(report.mismatched)) {
    console.log(`  ${type}: ${count} record(s) ${check ? "disagree" : "fixed"}`);
  }
  console.log(`  movements whose record is gone: ${report.movementsWithoutSource} (kept)`);
  console.log(`  totals that did not match the book: ${report.balancesOff} ${check ? "" : "(rebuilt)"}`.trimEnd());
  console.log(`  stock items with no product or material: ${report.stockItemsWithoutStockable}`);
  console.log(`  products or materials with no stock item: ${report.stockablesWithoutStockItem}`);
  console.log(
    `  material stock units out of step with the catalog: ${report.unitsOutOfStep}${check ? "" : " (re-synced)"}`,
  );
  console.log(
    `  not-tracked materials on a live bill of materials (use not recorded): ${report.untrackedMaterialsInUse}`,
  );
  if (check && !isClean(report)) process.exitCode = 2;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
