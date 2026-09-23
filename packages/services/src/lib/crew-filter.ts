/**
 * Where-fragment for a crew-only caller: rows in their workcenters, or in
 * no workcenter (site-level rows are plant things every crew member may
 * read). Empty when the caller sees the whole floor.
 */
export function crewFilter(workcenterIds: string[] | undefined) {
  return workcenterIds ? { OR: [{ workcenterId: { in: workcenterIds } }, { workcenterId: null }] } : {};
}
