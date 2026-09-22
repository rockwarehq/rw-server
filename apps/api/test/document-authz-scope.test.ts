import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAMContext } from "@rw/auth/context";

const state = vi.hoisted(() => ({ list: vi.fn(async () => ({ data: [], total: 0 })),
  documents: new Map<string, { id: string; siteId: string | null; parentId: null; deletedAt: null; links: [] }>() }));
vi.mock("@rw/db", () => ({ default: { document: {
  findUnique: async ({ where }: { where: { id: string } }) => state.documents.get(where.id) ?? null,
  findMany: async ({ where }: { where: { siteId: string | null } }) => [...state.documents.values()].filter((d) => d.siteId === where.siteId),
} } }));
vi.mock("@rw/services/document/index", () => ({ list: state.list }));
vi.mock("../src/auth/index.js", () => ({ Principal: { DISPLAY: "DISPLAY" } }));
vi.mock("../src/config.js", () => ({ storageConfig: { allowedDocumentContentTypes: ["application/pdf"], maxDocumentFileSizeBytes: 1000 } }));
vi.mock("../src/rpc/middleware.js", () => {
  const builder = { input: () => builder, handler: (handler: unknown) => handler };
  return { authRequired: builder, userOrDisplayRequired: builder, displayRequired: builder };
});
import { list } from "../src/rpc/document.js";

const iam: IAMContext = { principal: "USER", validToken: true, id: "u", workspaceId: "w", siteId: "active",
  permissionSnapshot: { systemRole: null, assignments: [
    { siteId: "active", permissions: ["production:read"] }, { siteId: "other", permissions: ["production:read"] },
  ] } };
const runList = (input: Record<string, unknown>) => (list as unknown as (args: { input: Record<string, unknown>; context: { iam: IAMContext } }) => Promise<unknown>)({ input, context: { iam } });
beforeEach(() => {
  vi.clearAllMocks();
  state.documents.clear();
  for (const siteId of ["active", "other", null]) state.documents.set(String(siteId), { id: String(siteId), siteId, parentId: null, deletedAt: null, links: [] });
});

describe("document list request scope", () => {
  it("omitted site means the current request site, with a non-overridable service predicate", async () => {
    await runList({});
    expect(state.list).toHaveBeenCalledWith({ siteId: "active" }, { siteId: "active", documentIds: ["active"] });
  });
  it("an accessible foreign parent cannot change the request site", async () => {
    await expect(runList({ parentId: "other" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.list).not.toHaveBeenCalled();
  });
  it("explicit null site requires workspace permission rather than any-site membership", async () => {
    await expect(runList({ siteId: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.list).not.toHaveBeenCalled();
  });
});
