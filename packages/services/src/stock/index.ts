// Stock domain (ADR-0016): the StockItem "stockable" record, the StockMovement
// book, and the StockBalance totals built from it.

export { createForStockable } from "./item.js";
export { ensureProductStockItems, postSources, reverseSources, type StockSource } from "./post.js";
export { getProductBalances, lockProductBalances, rebuildProductBalances, type ProductStockRow } from "./balance.js";
export { isClean, reconcileProductStock, type ReconcileReport } from "./reconcile.js";
