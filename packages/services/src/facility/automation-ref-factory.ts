import type { RefSource } from "@rw/automations";

/**
 * Shared builder for the site-scoped facility picker sources (stations, work centers). Both list
 * every named row under any site in the workspace, name-ordered, and map to `{ id, label }`; only
 * the Prisma model, the ref `key`, and the soft-delete filter differ. Each caller supplies a typed
 * `findRows(workspaceId)` thunk — passing the thunk sidesteps Prisma's cross-delegate union typing.
 */
export function createSiteScopedNameRef(opts: {
  key: string;
  findRows: (workspaceId: string) => Promise<Array<{ id: string; name: string }>>;
}): (workspaceId: string) => RefSource {
  return (workspaceId) => ({
    key: opts.key,
    async list(_ctx) {
      const rows = await opts.findRows(workspaceId);
      return rows.map((r) => ({ id: r.id, label: r.name }));
    },
  });
}
