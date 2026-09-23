import prisma from "@rw/db";
import { site, workcenter } from "@rw/services/facility/index";
import { afterAll, describe, expect, it } from "vitest";

// Tier 2: a bucket's name follows its site or workcenter through renames
// (screens that list buckets show these names).
describe.skipIf(!process.env.TEST_DATABASE_URL)("bucket names follow renames (Tier 2)", () => {
  let siteId: string | undefined;

  afterAll(async () => {
    if (siteId) await prisma.site.deleteMany({ where: { id: siteId } });
  });

  it("renaming a site or workcenter renames its bucket", async () => {
    const anchor = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { workspaceId: true } });
    const created = await site.create({ name: "Bucket Name Site", workspaceId: anchor.workspaceId });
    if ("error" in created) throw new Error(String(created.error));
    siteId = created.data.id;
    const cell = await workcenter.create({ name: "bn-cell", siteId });
    if ("error" in cell) throw new Error(String(cell.error));

    await site.update(siteId, { name: "Bucket Name Site (renamed)" });
    await workcenter.update(cell.data.id, { name: "bn-cell-renamed" });

    const buckets = await prisma.bucket.findMany({ where: { siteId }, select: { kind: true, name: true } });
    expect(buckets).toEqual(
      expect.arrayContaining([
        { kind: "PLANT", name: "Bucket Name Site (renamed)" },
        { kind: "WORKCENTER", name: "bn-cell-renamed" },
      ]),
    );
  });
});
