import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  mapWeightUnit,
  parseDecimalCommaNumber,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  product: string;
  material: string;
  weight: string;
  weightUnits: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importProductMaterials(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("ProductMaterial");
  void siteId; // not needed directly — FKs are resolved via IdMap

  const rows = await readData<SqlServerRow>("ProductMaterial");

  if (rows.length === 0) {
    log.warn("No ProductMaterial data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      const productId = idMap.get("product", row.product);
      if (!productId) {
        log.warn(`Product "${row.product}" not found in IdMap — skipping`);
        return;
      }

      const materialId = idMap.get("material", row.material);
      if (!materialId) {
        log.warn(`Material "${row.material}" not found in IdMap — skipping`);
        return;
      }

      const weight = parseDecimalCommaNumber(row.weight);
      const weightUnits = mapWeightUnit(row.weightUnits);

      const pm = await prisma.productMaterial.upsert({
        where: {
          productId_materialId: { productId, materialId },
        },
        update: {},
        create: {
          productId,
          materialId,
        },
        include: { currentVersion: true },
      });

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { currentVersionId: true },
      });
      const material = await prisma.material.findUnique({
        where: { id: materialId },
        select: { currentVersionId: true },
      });

      if (!product?.currentVersionId || !material?.currentVersionId) return;

      const current = pm.currentVersion;

      if (!current) {
        // First time we've seen this ProductMaterial — create v1 version and link it.
        const newVersion = await prisma.productMaterialVersion.create({
          data: {
            productMaterialId: pm.id,
            version: 1,
            weight,
            weightUnits,
            materialVersionId: material.currentVersionId,
            productVersionId: product.currentVersionId,
          },
        });
        await prisma.productMaterial.update({
          where: { id: pm.id },
          data: { currentVersionId: newVersion.id },
        });
        return;
      }

      const changed =
        (current.weight !== null ? Number(current.weight) : null) !== weight ||
        current.weightUnits !== weightUnits ||
        current.materialVersionId !== material.currentVersionId ||
        current.productVersionId !== product.currentVersionId;

      if (!changed) return;

      await prisma.productMaterialVersion.update({
        where: { id: current.id },
        data: {
          weight,
          weightUnits,
          materialVersionId: material.currentVersionId,
          productVersionId: product.currentVersionId,
        },
      });
    },
    { label: "product-materials" },
  );

  log.summary(result);
}
