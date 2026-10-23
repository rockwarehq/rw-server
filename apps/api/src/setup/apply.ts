import type { Prisma } from "@rw/db";
import { material as materialService, product as productService } from "@rw/services/inventory/index";
import type { EntityEventInput } from "@rw/services/write";

import { planSetup, type SetupChange, type SetupPlan, type SetupRow } from "./plan.js";
import type { SetupSpec } from "./spec.js";

// Applies a reviewed setup changeset a chunk at a time (see runner.ts). Each
// chunk is one transaction: it replans just its rows, refuses if any differ
// from the plan the person reviewed (STALE), then writes them through the
// inventory services (so versions, stock records and labels stay as the UI
// makes them), records each key as an external ref, and journals every write
// with what it was before, so the import can be rolled back.

type Tx = Prisma.TransactionClient;

/** Rows per transaction: ~16 ms a product with its BOM links, so a chunk is ~8 s. */
export const APPLY_CHUNK = 500;

export class SetupApplyError extends Error {
  constructor(
    readonly code: "STALE" | "NOT_APPLICABLE" | "WRITE_FAILED",
    message: string,
  ) {
    super(message);
  }
}

/** Records an apply would create or update. */
export function writeCount(plan: Pick<SetupPlan, "summary">): number {
  return Object.values(plan.summary).reduce((sum, counts) => sum + counts.create + counts.update, 0);
}

/** A service result's data; any error rolls the chunk back. */
function unwrapWrite<T>(result: { data?: T; error?: string }, what: string): T {
  if (result.error || result.data === undefined) {
    throw new SetupApplyError("WRITE_FAILED", `${what}: ${result.error ?? "nothing was written"}`);
  }
  return result.data;
}

/** Rollback order: links first, then products, then materials, then refs. */
const RANK = { link: 0, product: 1, material: 2, ref: 3 } as const;

interface JournalEntry {
  rank: number;
  entity: keyof typeof RANK;
  action: "create" | "update";
  entityId: string;
  materialId?: string;
  key: string;
  label: string;
  before?: Prisma.InputJsonValue;
  beforeVersionId?: string | null;
}

/** The fields a change list sets back, for restoring an update. */
const beforeFields = (changes: SetupChange[]) => ({
  fields: Object.fromEntries(changes.map((change) => [change.field, change.from])),
});

/**
 * What a reviewed row says, for comparing with the same row replanned now.
 * A link to a material this changeset created was planned with no material
 * id; once an earlier chunk wrote it, the replan has the id, so the reviewed
 * side takes it from the journal.
 */
function signature(row: SetupRow, createdMaterials: Map<string, string>): string {
  const changes = (list: SetupChange[]) => list.map((change) => [change.field, change.from, change.to]);
  return JSON.stringify([
    row.entity,
    row.key,
    row.action,
    row.entityId,
    changes(row.changes),
    (row.links ?? []).map((link) => [
      link.materialKey,
      link.materialId ?? createdMaterials.get(link.materialKey) ?? null,
      link.action,
      changes(link.changes),
    ]),
  ]);
}

/** Materials this changeset created in earlier chunks, by key. */
async function createdMaterialIds(tx: Tx, changesetId: string) {
  const rows = await tx.setupChangesetWrite.findMany({
    where: { changesetId, entity: "material", action: "create" },
    select: { key: true, entityId: true },
  });
  return new Map(rows.map((row) => [row.key, row.entityId]));
}

export interface ChunkResult {
  /** Records created or updated (BOM links count with their product). */
  written: number;
  events: EntityEventInput[];
}

/** Apply one chunk of reviewed rows inside `tx`. Throws SetupApplyError to roll the chunk back. */
export async function applyChunk(
  tx: Tx,
  input: { changesetId: string; siteId: string; spec: SetupSpec; rows: SetupRow[] },
): Promise<ChunkResult> {
  const { changesetId, siteId, spec, rows } = input;
  const events: EntityEventInput[] = [];
  const options = { tx, events };

  // ── Replan just these rows and compare with what the person reviewed ──────
  const pick = <T>(list: T[], index: number, what: string): T => {
    const item = list[index];
    if (!item) throw new SetupApplyError("WRITE_FAILED", `${what} ${index} is missing from the spec`);
    return item;
  };
  const subset: SetupSpec = {
    source: spec.source,
    materials: rows.filter((r) => r.entity === "material").map((r) => pick(spec.materials, r.index, "Material")),
    products: rows.filter((r) => r.entity === "product").map((r) => pick(spec.products, r.index, "Product")),
  };
  const fresh = await planSetup(tx, siteId, subset);
  const createdMaterials = await createdMaterialIds(tx, changesetId);
  const freshByKey = new Map(fresh.rows.map((row) => [`${row.entity}:${row.key}`, row]));
  for (const reviewed of rows) {
    const now = freshByKey.get(`${reviewed.entity}:${reviewed.key}`);
    if (!now || signature(now, createdMaterials) !== signature(reviewed, createdMaterials)) {
      throw new SetupApplyError(
        "STALE",
        `The plant changed since this import was planned (${reviewed.entity} ${reviewed.key}). Check it again before applying.`,
      );
    }
  }

  // ── What's there now, for the journal ─────────────────────────────────────
  const updated = (entity: "material" | "product") =>
    rows.filter((r) => r.entity === entity && r.entityId && r.action === "update").map((r) => r.entityId as string);
  const [materialsBefore, productsBefore] = await Promise.all([
    tx.material.findMany({ where: { id: { in: updated("material") } }, select: { id: true, currentVersionId: true } }),
    tx.product.findMany({ where: { id: { in: updated("product") } }, select: { id: true, currentVersionId: true } }),
  ]);
  const versionBefore = new Map([...materialsBefore, ...productsBefore].map((r) => [r.id, r.currentVersionId]));
  const linkProductIds = rows.filter((r) => r.entity === "product" && r.entityId).map((r) => r.entityId as string);
  const linksBefore = linkProductIds.length
    ? await tx.productMaterial.findMany({
        where: { productId: { in: linkProductIds } },
        select: { productId: true, materialId: true, currentVersionId: true },
      })
    : [];
  const linkVersionBefore = new Map(linksBefore.map((l) => [`${l.productId}:${l.materialId}`, l.currentVersionId]));
  const refsBefore = await tx.externalRef.findMany({
    where: {
      siteId,
      source: spec.source,
      OR: [
        { entityType: "MATERIAL", key: { in: subset.materials.map((m) => m.key) } },
        { entityType: "PRODUCT", key: { in: subset.products.map((p) => p.key) } },
      ],
    },
  });
  const refBefore = new Map(refsBefore.map((ref) => [`${ref.entityType}:${ref.key}`, ref]));

  const journal: JournalEntry[] = [];
  let written = 0;

  async function upsertRef(entityType: "MATERIAL" | "PRODUCT", key: string, label: string, entityId: string) {
    const before = refBefore.get(`${entityType}:${key}`);
    if (before && before.entityId === entityId && before.changesetId === changesetId) return;
    const ref = await tx.externalRef.upsert({
      where: { siteId_entityType_source_key: { siteId, entityType, source: spec.source, key } },
      update: { entityId, changesetId },
      create: { siteId, entityType, source: spec.source, key, entityId, changesetId },
      select: { id: true },
    });
    journal.push({
      rank: RANK.ref,
      entity: "ref",
      action: before ? "update" : "create",
      entityId: ref.id,
      key,
      label,
      ...(before ? { before: { entityId: before.entityId, changesetId: before.changesetId } } : {}),
    });
  }

  // ── Materials ─────────────────────────────────────────────────────────────
  for (const row of rows.filter((r) => r.entity === "material")) {
    const source = pick(spec.materials, row.index, "Material");
    const fields = {
      materialNumber: source.materialNumber ?? source.key,
      name: source.name,
      shortCode: source.shortCode,
      description: source.description,
      externalNumber: source.externalNumber,
      weightUnits: source.weightUnits,
      unitCost: source.unitCost,
    };
    let id = row.entityId;
    if (row.action === "create") {
      id = unwrapWrite(await materialService.create({ siteId, ...fields }, options), `Material ${row.key}`).id;
      journal.push({
        rank: RANK.material,
        entity: "material",
        action: "create",
        entityId: id,
        key: row.key,
        label: row.label,
      });
      written++;
    } else if (row.action === "update" && id) {
      unwrapWrite(await materialService.update(id, fields, options), `Material ${row.key}`);
      journal.push({
        rank: RANK.material,
        entity: "material",
        action: "update",
        entityId: id,
        key: row.key,
        label: row.label,
        before: beforeFields(row.changes),
        beforeVersionId: versionBefore.get(id) ?? null,
      });
      written++;
    }
    if (!id) throw new SetupApplyError("WRITE_FAILED", `Material ${row.key} has no record`);
    createdMaterials.set(row.key, id);
    await upsertRef("MATERIAL", row.key, row.label, id);
  }

  // ── Products and their BOM links ──────────────────────────────────────────
  for (const row of rows.filter((r) => r.entity === "product")) {
    const source = pick(spec.products, row.index, "Product");
    const fields = {
      sku: source.sku ?? source.key,
      name: source.name,
      description: source.description,
      externalSku: source.externalSku,
      weight: source.weight,
      weightUnits: source.weightUnits,
      itemCost: source.itemCost,
    };
    let id = row.entityId;
    if (row.action === "create") {
      id = unwrapWrite(await productService.create({ siteId, ...fields }, options), `Product ${row.key}`).id;
      journal.push({
        rank: RANK.product,
        entity: "product",
        action: "create",
        entityId: id,
        key: row.key,
        label: row.label,
      });
      written++;
    } else if (row.action === "update" && id && row.changes.length > 0) {
      unwrapWrite(await productService.update(id, fields, options), `Product ${row.key}`);
      journal.push({
        rank: RANK.product,
        entity: "product",
        action: "update",
        entityId: id,
        key: row.key,
        label: row.label,
        before: beforeFields(row.changes),
        beforeVersionId: versionBefore.get(id) ?? null,
      });
      written++;
    }
    if (!id) throw new SetupApplyError("WRITE_FAILED", `Product ${row.key} has no record`);

    for (const link of row.links ?? []) {
      if (link.action === "unchanged") continue;
      const linkSpec = (source.materials ?? []).find((m) => m.material === link.materialKey);
      const materialId = link.materialId ?? createdMaterials.get(link.materialKey);
      if (!linkSpec || !materialId) {
        throw new SetupApplyError("WRITE_FAILED", `Product ${row.key}: material ${link.materialKey} has no record`);
      }
      const linkInput = {
        productId: id,
        materialId,
        weight: linkSpec.weight,
        weightUnits: linkSpec.weightUnits,
        itemCost: linkSpec.itemCost,
      };
      const outcome =
        link.action === "create"
          ? await productService.addMaterial(linkInput, options)
          : await productService.updateMaterial(linkInput, options);
      unwrapWrite(outcome, `Product ${row.key} material ${link.materialKey}`);
      journal.push({
        rank: RANK.link,
        entity: "link",
        action: link.action,
        entityId: id,
        materialId,
        key: `${row.key} → ${link.materialKey}`,
        label: `${row.label} → ${link.materialName}`,
        ...(link.action === "update"
          ? {
              before: beforeFields(link.changes),
              beforeVersionId: linkVersionBefore.get(`${id}:${materialId}`) ?? null,
            }
          : {}),
      });
    }
    await upsertRef("PRODUCT", row.key, row.label, id);
  }

  // ── The journal, with the version each write left current ─────────────────
  if (journal.length > 0) {
    const ids = (entity: JournalEntry["entity"]) => journal.filter((j) => j.entity === entity).map((j) => j.entityId);
    const [materials, products, links, last] = await Promise.all([
      tx.material.findMany({ where: { id: { in: ids("material") } }, select: { id: true, currentVersionId: true } }),
      tx.product.findMany({ where: { id: { in: ids("product") } }, select: { id: true, currentVersionId: true } }),
      tx.productMaterial.findMany({
        where: { productId: { in: ids("link") } },
        select: { productId: true, materialId: true, currentVersionId: true },
      }),
      tx.setupChangesetWrite.findFirst({ where: { changesetId }, orderBy: { seq: "desc" }, select: { seq: true } }),
    ]);
    const after = new Map<string, string | null>([
      ...materials.map((r) => [r.id, r.currentVersionId] as const),
      ...products.map((r) => [r.id, r.currentVersionId] as const),
      ...links.map((l) => [`${l.productId}:${l.materialId}`, l.currentVersionId] as const),
    ]);
    const seq = (last?.seq ?? -1) + 1;
    await tx.setupChangesetWrite.createMany({
      data: journal.map((entry, i) => ({
        changesetId,
        seq: seq + i,
        rank: entry.rank,
        entity: entry.entity,
        action: entry.action,
        entityId: entry.entityId,
        materialId: entry.materialId ?? null,
        key: entry.key,
        label: entry.label,
        ...(entry.before !== undefined ? { before: entry.before } : {}),
        beforeVersionId: entry.beforeVersionId ?? null,
        afterVersionId:
          entry.entity === "ref"
            ? null
            : (after.get(entry.entity === "link" ? `${entry.entityId}:${entry.materialId}` : entry.entityId) ?? null),
      })),
    });
  }

  return { written, events };
}
