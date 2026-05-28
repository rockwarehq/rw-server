import type { RefSource } from "@rw/automations";
import prisma from "@rw/db";

/**
 * Station picker hook for the automation framework. Lists every non-deleted station under any
 * site in the workspace, name-ordered. Same `{ id, label, meta }` shape as the other sources so
 * the editor renders uniformly; site name is in `meta` to disambiguate same-named stations
 * across sites.
 */
export function createStationsAutomationRef(workspaceId: string): RefSource {
  return {
    key: "stations",
    async list(_ctx) {
      const rows = await prisma.station.findMany({
        where: { site: { workspaceId }, deletedAt: null },
        select: { id: true, name: true, site: { select: { name: true } } },
        orderBy: { name: "asc" },
      });
      return rows.map((s) => ({
        id: s.id,
        label: s.name,
        meta: { site: s.site.name },
      }));
    },
  };
}
