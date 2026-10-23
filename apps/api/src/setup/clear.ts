import prisma, { Prisma } from "@rw/db";
import { logEvent } from "@rw/services/audit/index";

import type { SetupFiles } from "./mapping.js";

// Clearing an import's data: once it's applied, discarded or rolled back,
// its spec, planned rows, uploaded files and write journal are only weight.
// The changeset itself stays (title, counts, files by name, who proposed and
// applied it, when), with every audit entry and the external refs the plant
// still uses to recognise those records on the next import. Without the
// journal it can no longer be rolled back.

export async function clearImportData(id: string, actorId: string | null, workspaceId: string) {
  const changeset = await prisma.setupChangeset.findUniqueOrThrow({
    where: { id },
    select: {
      siteId: true,
      mapping: true,
      origin: true,
      progress: true,
      _count: { select: { rows: true, writes: true } },
    },
  });
  // What it wrote, kept on the changeset: the journal these come from goes.
  const byAction = await prisma.setupChangesetWrite.groupBy({
    by: ["action"],
    where: { changesetId: id, entity: { in: ["material", "product"] } },
    _count: { _all: true },
  });
  const wrote = Object.fromEntries(
    byAction.map((row) => [row.action === "create" ? "created" : "changed", row._count._all]),
  );
  const progress = {
    ...((changeset.progress as Record<string, unknown> | null) ?? {}),
    created: 0,
    changed: 0,
    ...wrote,
  };
  const mapping = changeset.mapping as SetupFiles | null;
  // Keep the files' names: they say where the import came from.
  const files = (changeset.origin as { files?: string[] } | null)?.files ?? [];
  const uploads = [mapping?.materials?.upload, mapping?.products?.upload, mapping?.bom?.upload].filter(
    (upload): upload is string => !!upload,
  );
  await prisma.$transaction(
    async (tx) => {
      await tx.setupChangesetRow.deleteMany({ where: { changesetId: id } });
      await tx.setupChangesetWrite.deleteMany({ where: { changesetId: id } });
      if (uploads.length) await tx.setupUpload.deleteMany({ where: { id: { in: uploads } } });
      await tx.setupChangeset.update({
        where: { id },
        data: {
          spec: Prisma.DbNull,
          origin: files.length ? { files } : Prisma.DbNull,
          progress: progress as Prisma.InputJsonValue,
          clearedAt: new Date(),
        },
      });
    },
    { timeout: 120_000 },
  );
  await logEvent({
    action: "SETUP_CHANGESET_CLEARED",
    actorId: actorId ?? undefined,
    workspaceId,
    metadata: {
      changesetId: id,
      siteId: changeset.siteId,
      dropped: { rows: changeset._count.rows, journal: changeset._count.writes, files: uploads.length },
    },
  });
}
