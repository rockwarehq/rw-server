import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAMContext } from "@rw/auth/context";

const state = vi.hoisted(() => ({
  documents: new Map<
    string,
    {
      siteId: string | null;
      parentId: string | null;
      deletedAt: null;
      links: { targetType: string; targetId: string }[];
    }
  >(),
}));
vi.mock("@rw/db", () => ({
  default: {
    document: {
      findUnique: async ({ where }: { where: { id: string } }) => state.documents.get(where.id) ?? null,
      findMany: async () => [...state.documents.keys()].map((id) => ({ id })),
    },
    station: { findUnique: async ({ where }: { where: { id: string } }) => ({ siteId: "s", workcenterId: where.id }) },
  },
}));
import { authorizeDocument, readableDocumentIds } from "./access-scope.js";

const iam: IAMContext = {
  principal: "USER",
  validToken: true,
  id: "u",
  workspaceId: "w",
  siteId: "s",
  permissionSnapshot: {
    systemRole: null,
    assignments: [],
    workcenterGrants: [{ workcenterId: "wc-a", siteId: "s", access: "WRITE" }],
  },
};
const doc = (siteId: string | null, targets: string[] = [], parentId: string | null = null) => ({
  siteId,
  parentId,
  deletedAt: null,
  links: targets.map((targetId) => ({ targetType: "STATION", targetId })),
});
beforeEach(() => state.documents.clear());

describe("document actual target and parent authorization", () => {
  it("does not turn a null-site document into an any-site resource", async () => {
    state.documents.set("global", doc(null, ["wc-a"]));
    expect(await authorizeDocument(iam, "global")).toMatchObject({ ok: false });
    expect(await authorizeDocument(iam, "global", true)).toMatchObject({ ok: false });
  });
  it("validates all linked targets instead of accepting one accessible link", async () => {
    state.documents.set("own", doc("s", ["wc-a"]));
    state.documents.set("mixed", doc("s", ["wc-a", "wc-b"]));
    expect(await authorizeDocument(iam, "own", true)).toMatchObject({ ok: true, siteId: "s" });
    expect(await authorizeDocument(iam, "mixed")).toMatchObject({ ok: false });
    expect(await readableDocumentIds(iam, "s")).toEqual(["own"]);
  });
  it("inherits real parent restrictions and fails closed for cycles", async () => {
    state.documents.set("parent", doc("s", ["wc-b"]));
    state.documents.set("child", doc("s", [], "parent"));
    expect(await authorizeDocument(iam, "child")).toMatchObject({ ok: false });
    state.documents.set("parent", doc("s", [], "child"));
    expect(await authorizeDocument(iam, "child")).toMatchObject({ ok: false });
  });
  it("shared plant documents are reference reads but require configuration writes", async () => {
    state.documents.set("shared", doc("s"));
    expect(await authorizeDocument(iam, "shared")).toMatchObject({ ok: true });
    expect(await authorizeDocument(iam, "shared", true)).toMatchObject({ ok: false });
  });
});
