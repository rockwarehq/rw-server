import type { PrismaClient } from "@rw/db";
import { type IdMap, readData, batchUpsert, logger } from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  ProcessName: string;
  name: string;
  isActive: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importItemDispositionReasons(prisma: PrismaClient, idMap: IdMap, siteId: string): Promise<void> {
  const log = logger("ItemDispositionReason");

  const rows = await readData<SqlServerRow>("ItemDispositionReason");

  if (rows.length === 0) {
    log.warn("No ItemDispositionReason data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const dispositionIds = (
    await prisma.itemDisposition.findMany({
      where: { siteId, deletedAt: null },
      select: { id: true },
    })
  ).map((disposition) => ({ id: disposition.id }));

  const result = await batchUpsert(
    rows,
    async (row) => {
      // The legacy process group becomes a label on the code.
      let groupLabelId: string | null = null;
      if (row.ProcessName) {
        groupLabelId = idMap.get("label", row.ProcessName) ?? null;
        if (!groupLabelId) {
          log.warn(`Label "${row.ProcessName}" not found in IdMap for reason "${row.name}" — skipping label`);
        }
      }

      const existing = await prisma.itemDispositionReason.findFirst({
        where: { siteId, name: { equals: row.name, mode: "insensitive" } },
      });

      let record;
      if (existing) {
        record = await prisma.itemDispositionReason.update({
          where: { id: existing.id },
          data: {
            labels: groupLabelId ? { set: [{ id: groupLabelId }] } : undefined,
            itemDispositions: { set: dispositionIds },
          },
        });
      } else {
        record = await prisma.itemDispositionReason.create({
          data: {
            name: row.name,
            site: { connect: { id: siteId } },
            labels: groupLabelId ? { connect: [{ id: groupLabelId }] } : undefined,
            itemDispositions: dispositionIds.length > 0 ? { connect: dispositionIds } : undefined,
          },
        });
      }

      // Store mapping by name for downstream importers
      idMap.set("itemDispositionReason", row.name, record.id);
    },
    { label: "item disposition reasons" },
  );

  log.summary(result);
}
