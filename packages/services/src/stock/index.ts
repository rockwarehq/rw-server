// Stock domain (ADR-0016): the StockItem "stockable" record, the StockMovement
// book, and the StockBalance totals built from it — for parts and materials.

export { createForStockable } from "./item.js";
export {
  ensureBalances,
  ensureMaterialStockItems,
  ensureProductStockItems,
  postSources,
  repostSources,
  reverseSources,
  type StockSource,
} from "./post.js";
export {
  type BalanceScope,
  countOffBalances,
  getMaterialStock,
  getProductBalances,
  lockMaterialBalance,
  lockProductBalances,
  type MaterialStock,
  pendingMaterialUsage,
  rebuildBalances,
  rebuildItemBalances,
  rebuildProductBalances,
  type ProductStockRow,
  setMaterialStockUnit,
} from "./balance.js";
export {
  type CatchUpResult,
  catchUpAfterStockMigration,
  catchUpMaterialLedger,
  isClean,
  type MaterialCatchUpResult,
  materialMigrationTime,
  reconcileProductStock,
  reconcileStock,
  type ReconcileReport,
  stockMigrationTime,
} from "./reconcile.js";
