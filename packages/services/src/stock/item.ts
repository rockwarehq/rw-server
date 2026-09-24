import type { Prisma, StockableType } from "@rw/db";

// ============================================================================
// StockItem — the "stockable" record behind every product and material
// ============================================================================

/**
 * Make the StockItem for a new product or material. Call it inside the same
 * save that makes the product or material, so one never exists without the
 * other (ADR-0016).
 */
export async function createForStockable(
  tx: Prisma.TransactionClient,
  input: { stockableType: StockableType; stockableId: string; siteId: string; baseUnit?: string | null },
) {
  return tx.stockItem.create({
    data: {
      stockableType: input.stockableType,
      stockableId: input.stockableId,
      siteId: input.siteId,
      baseUnit: input.baseUnit ?? "",
    },
  });
}
