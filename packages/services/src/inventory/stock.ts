import type prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { getProductBalances, type ProductStockRow } from "../stock/balance.js";
import { reconcileProductStock } from "../stock/reconcile.js";

// ============================================================================
// Product stock — kept for existing callers
// ============================================================================
//
// On-hand stock now lives in the stock book (StockMovement) and its totals
// (StockBalance); see ../stock and ADR-0016. These wrappers keep the old
// names and shapes so the API does not change.

export type { ProductStockRow };

/**
 * Read stock rows for a set of products. Products with no row yet are returned
 * as all-zero so callers never special-case missing rows.
 */
export async function getStock(
  client: Prisma.TransactionClient | typeof prisma,
  siteId: string,
  productIds: string[],
): Promise<Map<string, ProductStockRow>> {
  return getProductBalances(client, siteId, productIds);
}

/**
 * Check the stock book against the records it comes from, fix what
 * disagrees, and rebuild the totals. Safe to run any time.
 */
export async function rederiveProductStock(siteId?: string) {
  return reconcileProductStock({ siteId, repair: true });
}
