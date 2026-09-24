// Stock domain (ADR-0016): the StockItem "stockable" record, the StockMovement
// book, and the StockBalance totals built from it.

export { createForStockable } from "./item.js";
export {
  ensureBalances,
  ensureProductStockItems,
  postSources,
  repostSources,
  reverseSources,
  type StockSource,
} from "./post.js";
export {
  countOffBalances,
  getProductBalances,
  lockProductBalances,
  rebuildProductBalances,
  type ProductStockRow,
} from "./balance.js";
export {
  type CatchUpResult,
  catchUpAfterStockMigration,
  isClean,
  reconcileProductStock,
  type ReconcileReport,
  stockMigrationTime,
} from "./reconcile.js";
