import prisma from "@rw/db";
import { getSiteSettings } from "../facility/site/settings.js";
import { computeCoverage } from "./coverage.js";
import { transitionStatus } from "./order.js";

// ============================================================================
// The one fulfillment automation
// ============================================================================
//
// When Site settings enable orderAutoComplete, an order whose FIFO coverage
// reaches 100% is completed automatically — via the exact same transitionStatus
// path a user takes, so there is still a single writer of Order.status.
// Runs post-commit and fire-and-forget: it must never run inside (or fail) a
// production cycle transaction. Races with manual completion are resolved by
// the completion transaction itself (re-validation + FOR UPDATE stock locks);
// the loser gets a harmless INVALID_TRANSITION / PARTIAL_COVERAGE.

/**
 * Check whether any open orders carrying the given products are now fully
 * covered, and complete them in queue order. FIFO-strict: only orders whose
 * every line is fully covered *in queue position* complete — stock notionally
 * covering an earlier order never auto-completes a later one.
 */
export async function checkAutoComplete(siteId: string, productIds: string[]): Promise<void> {
  if (productIds.length === 0) return;

  const settings = await getSiteSettings(siteId);
  if ("error" in settings || !settings.data.orderAutoComplete) return;

  // Candidates: open-queue orders with at least one line in the touched
  // products, in queue order. Coverage is then computed over the union of ALL
  // their products (an order only completes when every line is covered).
  const candidates = await prisma.order.findMany({
    where: {
      siteId,
      status: { in: ["OPEN", "IN_PROGRESS"] },
      deletedAt: null,
      lineItems: { some: { productId: { in: productIds } } },
    },
    select: {
      id: true,
      lineItems: { select: { id: true, productId: true } },
    },
    orderBy: [{ sequence: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  if (candidates.length === 0) return;

  const allProductIds = [...new Set(candidates.flatMap((o) => o.lineItems.map((li) => li.productId)))];
  const coverage = await computeCoverage(siteId, allProductIds);

  for (const candidate of candidates) {
    if (candidate.lineItems.length === 0) continue;
    const fullyCovered = candidate.lineItems.every(
      (li) => (coverage.byLineItem.get(li.id)?.remainingQuantity ?? Number.POSITIVE_INFINITY) <= 0,
    );
    if (!fullyCovered) continue;
    const result = await transitionStatus(candidate.id, "COMPLETED", { allowPartial: false, source: "AUTO" });
    if ("error" in result && result.code !== "INVALID_TRANSITION" && result.code !== "PARTIAL_COVERAGE") {
      console.error(`[order-auto-complete] Failed to complete order ${candidate.id}: ${result.error}`);
    }
  }
}
