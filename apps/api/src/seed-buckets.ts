import prisma from "@rw/db";

// Buckets are created with their sites/workcenters at runtime; this heals
// any rows created outside the services (imports, tests, manual SQL) —
// run on every deploy and by the dev importer.
export async function ensureBuckets(): Promise<void> {
  const sites = await prisma.site.findMany({ select: { id: true, workspaceId: true, name: true } });
  for (const site of sites) {
    const existing = await prisma.bucket.findFirst({
      where: { siteId: site.id, kind: "PLANT" },
      select: { id: true },
    });
    if (!existing) {
      await prisma.bucket.create({
        data: { workspaceId: site.workspaceId, siteId: site.id, kind: "PLANT", name: site.name },
      });
    }
  }
  const workcenters = await prisma.workcenter.findMany({
    where: { bucket: null },
    select: { id: true, name: true, site: { select: { id: true, workspaceId: true } } },
  });
  for (const wc of workcenters) {
    await prisma.bucket.create({
      data: {
        workspaceId: wc.site.workspaceId,
        siteId: wc.site.id,
        kind: "WORKCENTER",
        workcenterId: wc.id,
        name: wc.name,
      },
    });
  }
}
