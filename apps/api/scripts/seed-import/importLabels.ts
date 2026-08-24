import type { PrismaClient } from "@rw/db";
import { type IdMap, readData, batchUpsert, logger } from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  name: string;
  Description: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importLabels(prisma: PrismaClient, idMap: IdMap, siteId: string): Promise<void> {
  const log = logger("Label");

  const rows = await readData<SqlServerRow>("ProcessType");

  if (rows.length === 0) {
    log.warn("No ProcessType data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      // The legacy system's process groups become labels. Case-insensitive
      // existence check (treats "MOLD" / "Mold" as the same); can't use the
      // siteId_name upsert because that's case-sensitive.
      const existing = await prisma.label.findFirst({
        where: { siteId, name: { equals: row.name, mode: "insensitive" } },
      });

      const record = existing ?? (await prisma.label.create({ data: { name: row.name, siteId } }));

      // Store mapping by name since SQL Server source has no UUID
      idMap.set("label", row.name, record.id);
    },
    { label: "labels" },
  );

  log.summary(result);
}
