import type { Prisma } from "@rw/db";
import { SYSTEM_ENTITY_KEYS } from "@rw/services/entity/registry";
import { material as materialService, product as productService } from "@rw/services/inventory/index";
import { setMaterialStockUnit } from "@rw/services/stock/balance";
import { emitEntityEvent, type EntityEventInput } from "@rw/services/write";

// Reverses what an import wrote, from its journal (SetupChangesetWrite), a
// chunk of entries per transaction: BOM links first, then products, then
// materials, then external refs, newest first within each. Every entry is
// decided on its own when its turn comes:
//
//   rollback  created records are deleted the way IMM deletes them (marked
//             deleted, history kept); changed records get their old values
//             back as a new version.
//   remove    created records are removed outright, with their versions,
//             stock record and links; changed records go back to the version
//             they had, and the import's version is dropped. Plant ADMIN only.
//             It is the one exception to "products and materials are never
//             really deleted" (ADR-0016), and only for records this import
//             made that nothing has used since.
//
// Anything changed since the import, or used since, is skipped with its
// reason: rollback never overwrites someone's later work.

type Tx = Prisma.TransactionClient;
export type RollbackMode = "rollback" | "remove";

export const ROLLBACK_CHUNK = 500;

type Entry = Awaited<ReturnType<Tx["setupChangesetWrite"]["findMany"]>>[number];
type Outcome = { outcome: "deleted" | "removed" | "restored" | "gone" | "skipped"; reason?: string };

const skipped = (reason: string): Outcome => ({ outcome: "skipped", reason });
const CHANGED_SINCE = "Changed since the import. Roll back later imports or edits first, or leave it.";

/** Journal entries a mode still has to do. */
export function pendingWhere(changesetId: string, mode: RollbackMode): Prisma.SetupChangesetWriteWhereInput {
  return mode === "rollback"
    ? { changesetId, outcome: null }
    : // Removing after a rollback finishes off what the rollback only marked deleted.
      {
        changesetId,
        OR: [{ outcome: null }, { outcome: "deleted", entity: { in: ["product", "material"] } }],
      };
}

function restoreFields(entry: Entry): Record<string, unknown> {
  return ((entry.before as { fields?: Record<string, unknown> } | null)?.fields ?? {}) as Record<string, unknown>;
}

/** Why a record can't be removed outright, if something uses it. */
async function productInUse(tx: Tx, id: string): Promise<string | null> {
  const product = await tx.product.findUnique({
    where: { id },
    select: {
      _count: {
        select: {
          jobProducts: true,
          orderLineItems: true,
          consumptions: true,
          stockAdjustments: true,
          inventoryItems: true,
          itemDispositionLogs: true,
          calls: true,
          modeLogs: true,
          materialShiftUsage: true,
          pictures: true,
          materials: true,
          materialAltGroups: true,
        },
      },
    },
  });
  if (!product) return null;
  const c = product._count;
  if (c.jobProducts) return "Used by jobs.";
  if (c.orderLineItems || c.consumptions) return "On orders.";
  if (c.stockAdjustments || c.inventoryItems || c.itemDispositionLogs) return "Has stock or production records.";
  if (c.calls || c.modeLogs || c.materialShiftUsage) return "Has production history.";
  if (c.pictures) return "Has pictures added since.";
  if (c.materials || c.materialAltGroups) return "Has materials added since.";
  return (await stockOrDocuments(tx, "PRODUCT", id)) ?? null;
}

async function materialInUse(tx: Tx, id: string): Promise<string | null> {
  const material = await tx.material.findUnique({
    where: { id },
    select: { _count: { select: { products: true, ledgerEntries: true, shiftUsage: true } } },
  });
  if (!material) return null;
  const c = material._count;
  if (c.products) return "Used by products.";
  if (c.ledgerEntries || c.shiftUsage) return "Has stock or usage records.";
  return (await stockOrDocuments(tx, "MATERIAL", id)) ?? null;
}

async function stockOrDocuments(tx: Tx, type: "PRODUCT" | "MATERIAL", id: string): Promise<string | null> {
  const [stock, documents] = await Promise.all([
    tx.stockItem.findUnique({
      where: { stockableType_stockableId: { stockableType: type, stockableId: id } },
      select: { _count: { select: { movements: true } } },
    }),
    tx.documentLink.count({ where: { targetType: type, targetId: id } }),
  ]);
  if (stock?._count.movements) return "Has stock movements.";
  if (documents) return "Has documents linked.";
  return null;
}

async function linkInUse(tx: Tx, productId: string, materialId: string): Promise<string | null> {
  const used = await tx.productMaterialVersion.count({
    where: {
      productMaterial: { productId, materialId },
      OR: [{ inventoryItems: { some: {} } }, { itemDispositionLogs: { some: {} } }],
    },
  });
  return used ? "Recorded in production since." : null;
}

/** Whether a product this changeset created will be left alone by rollback (changed since). */
async function productStays(tx: Tx, changesetId: string, productId: string): Promise<boolean> {
  const made = await tx.setupChangesetWrite.findFirst({
    where: { changesetId, entity: "product", action: "create", entityId: productId },
    select: { afterVersionId: true },
  });
  if (!made) return false;
  const product = await tx.product.findUnique({ where: { id: productId }, select: { currentVersionId: true } });
  return !!product && product.currentVersionId !== made.afterVersionId;
}

/** Remove a product outright: stock record, labels, versions, the product. Its links are already gone. */
async function removeProduct(tx: Tx, id: string) {
  await tx.stockItem.deleteMany({ where: { stockableType: "PRODUCT", stockableId: id } });
  await tx.product.update({ where: { id }, data: { currentVersionId: null, labels: { set: [] } } });
  await tx.productVersion.deleteMany({ where: { productId: id } });
  await tx.product.delete({ where: { id } });
}

async function removeMaterial(tx: Tx, id: string) {
  await tx.stockItem.deleteMany({ where: { stockableType: "MATERIAL", stockableId: id } });
  await tx.material.update({ where: { id }, data: { currentVersionId: null, labels: { set: [] } } });
  await tx.materialVersion.deleteMany({ where: { materialId: id } });
  await tx.material.delete({ where: { id } });
}

/**
 * Put a changed record back on the version it had and drop the import's
 * version when nothing points at it. Returns false when that can't be done
 * (no earlier version recorded), so the caller restores by value instead.
 */
async function revertVersion(tx: Tx, entry: Entry): Promise<boolean> {
  const before = entry.beforeVersionId;
  const after = entry.afterVersionId;
  if (!before || !after) return false;
  if (entry.entity === "product") {
    await tx.product.update({ where: { id: entry.entityId }, data: { currentVersionId: before } });
    const used = await tx.productVersion.count({
      where: {
        id: after,
        OR: [
          { productMaterialVersions: { some: {} } },
          { inventoryItems: { some: {} } },
          { itemDispositionLogs: { some: {} } },
        ],
      },
    });
    if (!used) await tx.productVersion.delete({ where: { id: after } });
  } else if (entry.entity === "material") {
    const restored = await tx.material.update({
      where: { id: entry.entityId },
      data: { currentVersionId: before },
      select: { currentVersion: { select: { weightUnits: true } } },
    });
    // Stock follows the unit back, as it does when IMM changes it (ADR-0016).
    await setMaterialStockUnit(tx, entry.entityId, restored.currentVersion?.weightUnits ?? "");
    const used = await tx.materialVersion.count({ where: { id: after, productMaterialVersions: { some: {} } } });
    if (!used) await tx.materialVersion.delete({ where: { id: after } });
  } else if (entry.entity === "link" && entry.materialId) {
    await tx.productMaterial.update({
      where: { productId_materialId: { productId: entry.entityId, materialId: entry.materialId } },
      data: { currentVersionId: before },
    });
    const used = await tx.productMaterialVersion.count({
      where: { id: after, OR: [{ inventoryItems: { some: {} } }, { itemDispositionLogs: { some: {} } }] },
    });
    if (!used) await tx.productMaterialVersion.delete({ where: { id: after } });
  } else return false;
  return true;
}

/** Decide and do one journal entry. */
async function undo(
  tx: Tx,
  entry: Entry,
  mode: RollbackMode,
  ctx: { changesetId: string; siteId: string; workspaceId: string; events: EntityEventInput[] },
): Promise<Outcome> {
  const options = { tx, events: ctx.events };
  const emit = (entityKey: string, entityId: string, action: "updated" | "deleted") =>
    emitEntityEvent(options, { action, entityKey, entityId, siteId: ctx.siteId, workspaceId: ctx.workspaceId });

  switch (entry.entity) {
    case "link": {
      if (!entry.materialId) return skipped("No material recorded.");
      const link = await tx.productMaterial.findUnique({
        where: { productId_materialId: { productId: entry.entityId, materialId: entry.materialId } },
        select: { currentVersionId: true, altGroupId: true },
      });
      if (!link) return { outcome: "gone" };
      if (link.currentVersionId !== entry.afterVersionId) return skipped(CHANGED_SINCE);
      if (entry.action === "create") {
        if (link.altGroupId) return skipped("Put in an alternates group since.");
        // A part this import made that stays (changed since) keeps its materials list.
        if (await productStays(tx, ctx.changesetId, entry.entityId)) {
          return skipped("Its part was changed since and stays, so its materials list stays too.");
        }
        const used = await linkInUse(tx, entry.entityId, entry.materialId);
        if (used) return skipped(used);
        const result = await productService.removeMaterial(entry.entityId, entry.materialId, undefined, options);
        return "error" in result && result.error ? skipped(result.error) : { outcome: "removed" };
      }
      if (mode === "remove" && (await revertVersion(tx, entry))) {
        emit(SYSTEM_ENTITY_KEYS.Product, entry.entityId, "updated");
        return { outcome: "restored" };
      }
      const result = await productService.updateMaterial(
        { productId: entry.entityId, materialId: entry.materialId, ...restoreFields(entry) } as never,
        options,
      );
      return result.error ? skipped(result.error) : { outcome: "restored" };
    }

    case "product":
    case "material": {
      const isProduct = entry.entity === "product";
      const record = isProduct
        ? await tx.product.findUnique({
            where: { id: entry.entityId },
            select: { currentVersionId: true, deletedAt: true },
          })
        : await tx.material.findUnique({
            where: { id: entry.entityId },
            select: { currentVersionId: true, deletedAt: true },
          });
      if (!record) return { outcome: "gone" };
      const entityKey = isProduct ? SYSTEM_ENTITY_KEYS.Product : SYSTEM_ENTITY_KEYS.Material;

      if (entry.action === "create") {
        if (record.currentVersionId !== entry.afterVersionId) return skipped(CHANGED_SINCE);
        if (mode === "rollback") {
          if (record.deletedAt) return { outcome: "gone" };
          const result = isProduct
            ? await productService.remove(entry.entityId, options)
            : await materialService.remove(entry.entityId, options);
          return "error" in result && result.error ? skipped(result.error) : { outcome: "deleted" };
        }
        const used = isProduct ? await productInUse(tx, entry.entityId) : await materialInUse(tx, entry.entityId);
        if (used) return skipped(used);
        if (isProduct) await removeProduct(tx, entry.entityId);
        else await removeMaterial(tx, entry.entityId);
        emit(entityKey, entry.entityId, "deleted");
        return { outcome: "removed" };
      }

      // An update: put the old values back, unless someone changed it since.
      if (record.deletedAt) return { outcome: "gone" };
      if (record.currentVersionId !== entry.afterVersionId) return skipped(CHANGED_SINCE);
      if (mode === "remove" && (await revertVersion(tx, entry))) {
        emit(entityKey, entry.entityId, "updated");
        return { outcome: "restored" };
      }
      const fields = restoreFields(entry) as never;
      const result = isProduct
        ? await productService.update(entry.entityId, fields, options)
        : await materialService.update(entry.entityId, fields, options);
      return result.error ? skipped(result.error) : { outcome: "restored" };
    }

    case "ref": {
      const ref = await tx.externalRef.findUnique({ where: { id: entry.entityId } });
      if (!ref) return { outcome: "gone" };
      const target =
        ref.entityType === "PRODUCT"
          ? await tx.product.findUnique({ where: { id: ref.entityId }, select: { deletedAt: true } })
          : await tx.material.findUnique({ where: { id: ref.entityId }, select: { deletedAt: true } });
      const targetGone = !target || target.deletedAt !== null;
      if (entry.action === "create") {
        // A key whose record stays (skipped above) keeps finding it on the next import.
        if (!targetGone) return skipped("Its record stays.");
        await tx.externalRef.delete({ where: { id: ref.id } });
        return { outcome: "deleted" };
      }
      const before = entry.before as { entityId: string; changesetId: string | null } | null;
      if (!before) return skipped("No earlier ref recorded.");
      await tx.externalRef.update({
        where: { id: ref.id },
        data: { changesetId: before.changesetId, ...(targetGone ? { entityId: before.entityId } : {}) },
      });
      return { outcome: "restored" };
    }

    default:
      return skipped(`Unknown entry ${entry.entity}.`);
  }
}

/** Undo up to one chunk of a changeset's journal inside `tx`. Returns how many entries it settled. */
export async function rollbackChunk(
  tx: Tx,
  input: { changesetId: string; siteId: string; workspaceId: string; mode: RollbackMode },
): Promise<{ settled: number; events: EntityEventInput[] }> {
  const entries = await tx.setupChangesetWrite.findMany({
    where: pendingWhere(input.changesetId, input.mode),
    orderBy: [{ rank: "asc" }, { seq: "desc" }],
    take: ROLLBACK_CHUNK,
  });
  const events: EntityEventInput[] = [];
  for (const entry of entries) {
    const result = await undo(tx, entry, input.mode, { ...input, events });
    await tx.setupChangesetWrite.update({
      where: { id: entry.id },
      data: { outcome: result.outcome, reason: result.reason ?? null },
    });
  }
  return { settled: entries.length, events };
}
