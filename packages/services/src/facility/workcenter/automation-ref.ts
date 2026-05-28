import type { RefSource } from "@rw/automations";
import prisma from "@rw/db";

/**
 * Workcenter picker hook for the automation framework. Lists every workcenter under any site in
 * the workspace, name-ordered. Same `{ id, label, meta }` shape as the other sources; site name
 * is in `meta` to disambiguate same-named workcenters across sites.
 *
 * When automations grow site scoping, callers can pass a `siteId` through `RefContext` and this
 * source will narrow.
 */
export function createWorkcentersAutomationRef(workspaceId: string): RefSource {
  return {
    key: "workCenters",
    async list(_ctx) {
      const rows = await prisma.workcenter.findMany({
        where: { site: { workspaceId } },
        select: { id: true, name: true, site: { select: { name: true } } },
        orderBy: { name: "asc" },
      });
      return rows.map((wc) => ({
        id: wc.id,
        label: wc.name,
        meta: { site: wc.site.name },
      }));
    },
  };
}
