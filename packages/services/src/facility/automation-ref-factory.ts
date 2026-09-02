import type { RefSource } from "@rw/automations";

/**
 * Shared builder for name-labelled picker sources. Each caller supplies a typed `findRows(siteId?)`
 * thunk — passing the thunk sidesteps Prisma's cross-delegate union typing. `siteId` comes from the
 * editor's ref context so a site-scoped automation only offers its own site's rows.
 */
export function createNameRef(opts: {
  key: string;
  findRows: (siteId?: string) => Promise<Array<{ id: string; name: string }>>;
}): RefSource {
  return {
    key: opts.key,
    async list(ctx) {
      const rows = await opts.findRows(typeof ctx.siteId === "string" ? ctx.siteId : undefined);
      return rows.map((r) => ({ id: r.id, label: r.name }));
    },
  };
}
