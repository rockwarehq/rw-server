import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import * as views from "./crud.js";

// Integration tests (document.test.ts conventions): require DATABASE_URL and
// exercise the real visibility/permission matrix with an isolated fixture
// graph: one workspace with two users, plus a foreign workspace.

describe.skipIf(!process.env.DATABASE_URL)("savedView service", () => {
  let workspaceId: string;
  let siteId: string;
  let scopeId: string;
  let ownerId: string;
  let memberId: string;
  let foreignWorkspaceId: string;

  const SHIFT_VIEW_CONFIG = { stationIds: null, stationsLayout: "list" };

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({
      data: { name: `SavedView Test ${suffix}`, slug: `saved-view-${suffix}` },
    });
    workspaceId = workspace.id;
    const foreign = await prisma.workspace.create({
      data: { name: `SavedView Foreign ${suffix}`, slug: `saved-view-f-${suffix}` },
    });
    foreignWorkspaceId = foreign.id;

    const site = await prisma.site.create({
      data: { name: `SavedView Site ${suffix}`, workspaceId },
    });
    siteId = site.id;
    scopeId = randomUUID(); // soft scope anchor — no FK

    const owner = await prisma.user.create({
      data: { email: `owner-${suffix}@test.local`, passwordHash: "x" },
    });
    ownerId = owner.id;
    const member = await prisma.user.create({
      data: { email: `member-${suffix}@test.local`, passwordHash: "x" },
    });
    memberId = member.id;
  });

  async function createView(visibility: "PRIVATE" | "WORKSPACE", name = `View ${randomUUID()}`) {
    const result = await views.create(
      {
        siteId,
        page: "shift-view",
        scopeId,
        name,
        visibility,
        config: SHIFT_VIEW_CONFIG,
        createdById: ownerId,
      },
      workspaceId,
    );
    if (result.error !== undefined) throw new Error(result.error);
    return result.data;
  }

  test("list shows WORKSPACE views to everyone but PRIVATE views only to their creator", async () => {
    const shared = await createView("WORKSPACE");
    const priv = await createView("PRIVATE");

    const asOwner = await views.list({ siteId, page: "shift-view", scopeId, userId: ownerId }, workspaceId);
    if (asOwner.error !== undefined) throw new Error(asOwner.error);
    const ownerIds = asOwner.data.map((v) => v.id);
    expect(ownerIds).toContain(shared.id);
    expect(ownerIds).toContain(priv.id);

    const asMember = await views.list({ siteId, page: "shift-view", scopeId, userId: memberId }, workspaceId);
    if (asMember.error !== undefined) throw new Error(asMember.error);
    const memberIds = asMember.data.map((v) => v.id);
    expect(memberIds).toContain(shared.id);
    expect(memberIds).not.toContain(priv.id);
  });

  test("any member can publish config to a WORKSPACE view", async () => {
    const shared = await createView("WORKSPACE");
    const result = await views.update(
      shared.id,
      { actorId: memberId, config: { ...SHIFT_VIEW_CONFIG, stationsLayout: "cards" } },
      workspaceId,
    );
    expect(result.error).toBeUndefined();
    if (result.error !== undefined || result.data === undefined) {
      throw new Error("expected update to succeed");
    }
    expect((result.data.config as Record<string, unknown>).stationsLayout).toBe("cards");
  });

  test("rename/reshare/delete of a WORKSPACE view are creator-only", async () => {
    const shared = await createView("WORKSPACE");

    const rename = await views.update(shared.id, { actorId: memberId, name: "Hijacked" }, workspaceId);
    expect(rename.error).toBeDefined();
    if (rename.error !== undefined) expect(rename.code).toBe("FORBIDDEN");

    const reshare = await views.update(shared.id, { actorId: memberId, visibility: "PRIVATE" }, workspaceId);
    expect(reshare.error).toBeDefined();

    const del = await views.remove(shared.id, { actorId: memberId }, workspaceId);
    expect(del.error).toBeDefined();
    if (del.error !== undefined) expect(del.code).toBe("FORBIDDEN");

    const ownerRename = await views.update(shared.id, { actorId: ownerId, name: "Renamed" }, workspaceId);
    expect(ownerRename.error).toBeUndefined();
  });

  test("PRIVATE views reject all mutations from non-owners", async () => {
    const priv = await createView("PRIVATE");
    const result = await views.update(
      priv.id,
      { actorId: memberId, config: SHIFT_VIEW_CONFIG },
      workspaceId,
    );
    expect(result.error).toBeDefined();
    if (result.error !== undefined) expect(result.code).toBe("FORBIDDEN");
  });

  test("delete soft-deletes and removes the view from lists", async () => {
    const shared = await createView("WORKSPACE");
    const del = await views.remove(shared.id, { actorId: ownerId }, workspaceId);
    expect(del.error).toBeUndefined();

    const after = await views.list({ siteId, page: "shift-view", scopeId, userId: ownerId }, workspaceId);
    if (after.error !== undefined) throw new Error(after.error);
    expect(after.data.map((v) => v.id)).not.toContain(shared.id);

    const row = await prisma.savedView.findUnique({ where: { id: shared.id }, select: { deletedAt: true } });
    expect(row?.deletedAt).not.toBeNull();
  });

  test("wrong workspace is rejected on every verb", async () => {
    const shared = await createView("WORKSPACE");

    const listResult = await views.list(
      { siteId, page: "shift-view", scopeId, userId: ownerId },
      foreignWorkspaceId,
    );
    expect(listResult.error).toBeDefined();

    const updateResult = await views.update(shared.id, { actorId: ownerId, name: "X" }, foreignWorkspaceId);
    expect(updateResult.error).toBeDefined();
  });
});
