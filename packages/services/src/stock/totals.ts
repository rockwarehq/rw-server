import { Prisma } from "@rw/db";

// ============================================================================
// Adding movements up into StockBalance columns
// ============================================================================
//
// One place for the sums, so totals kept up by posting and totals rebuilt
// from the book are always added up the same way: each movement converted to
// its item's baseUnit one row at a time (stock_convert rounds per row), then
// split by kind.

/**
 * SELECT per stock item: id, on_hand, produced, scrapped, consumed, adjusted,
 * received, issued. `from` must name movements as `m`, joined to their
 * StockItem as `si` (it may also LEFT JOIN, for items with no movements).
 */
export function totalsSelect(from: Prisma.Sql): Prisma.Sql {
  const q = Prisma.sql`stock_convert(m.quantity, m.unit, si."baseUnit")`;
  return Prisma.sql`
    SELECT si.id,
           COALESCE(SUM(${q}), 0) AS on_hand,
           COALESCE(SUM(${q}) FILTER (WHERE m.kind = 'OUTPUT'), 0) AS produced,
           COALESCE(-SUM(${q}) FILTER (WHERE m.kind = 'SCRAP'), 0) AS scrapped,
           COALESCE(-SUM(${q}) FILTER (WHERE m.kind = 'FULFILLMENT'), 0) AS consumed,
           COALESCE(SUM(${q}) FILTER (WHERE m.kind = 'ADJUSTMENT'), 0) AS adjusted,
           COALESCE(SUM(${q}) FILTER (WHERE m.kind IN ('RECEIPT', 'TRANSFER_IN', 'OPENING_BALANCE')), 0) AS received,
           COALESCE(-SUM(${q}) FILTER (WHERE m.kind IN ('USAGE', 'WRITE_OFF', 'TRANSFER_OUT')), 0) AS issued
    ${from}
    GROUP BY si.id`;
}
