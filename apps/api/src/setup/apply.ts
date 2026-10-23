import prisma, { type Prisma } from "@rw/db";
import { publishEntityEvent } from "@rw/services/entity/events";
import { material as materialService, product as productService } from "@rw/services/inventory/index";
import type { EntityEventInput } from "@rw/services/write";

import { planFingerprint, planSetup, type SetupPlan } from "./plan.js";
import type { SetupSpec } from "./spec.js";

// Applies a reviewed setup changeset in one transaction: replans inside it,
// refuses if the plant changed since the plan the person saw, then writes
// every row through the inventory services (so versions, stock records and
// labels stay as the UI makes them) and records each key as an external ref.
// Entity events go out only after commit.

export class SetupApplyError extends Error {
  constructor(
    readonly code: "STALE" | "NOT_APPLICABLE" | "WRITE_FAILED",
    message: string,
    readonly plan?: SetupPlan,
  ) {
    super(message);
  }
}

/**
 * Records one apply writes, at most, for now: it is one transaction, at
 * ~16 ms a product (BOM links and refs included), so 2,000 is ~35 s.
 * Chunked background apply lifts this.
 */
export const MAX_APPLY_ROWS = 2000;

/** Records an apply would create or update. */
export function writeCount(plan: Pick<SetupPlan, "summary">): number {
  return Object.values(plan.summary).reduce((sum, counts) => sum + counts.create + counts.update, 0);
}

export interface SetupApplyResult {
  written: { materials: Record<string, string>; products: Record<string, string> };
  plan: SetupPlan;
}

/** A service result's data; any error rolls the whole changeset back. */
function unwrapWrite<T>(result: { data?: T; error?: string }, what: string): T {
  if (result.error || result.data === undefined) {
    throw new SetupApplyError("WRITE_FAILED", `${what}: ${result.error ?? "nothing was written"}`);
  }
  return result.data;
}

async function upsertRef(
  tx: Prisma.TransactionClient,
  input: { siteId: string; entityType: "MATERIAL" | "PRODUCT"; source: string; key: string; entityId: string },
  changesetId: string,
) {
  await tx.externalRef.upsert({
    where: {
      siteId_entityType_source_key: {
        siteId: input.siteId,
        entityType: input.entityType,
        source: input.source,
        key: input.key,
      },
    },
    update: { entityId: input.entityId, changesetId },
    create: { ...input, changesetId },
  });
}

export async function applySetup(input: {
  siteId: string;
  changesetId: string;
  spec: SetupSpec;
  reviewedPlan: SetupPlan;
}): Promise<SetupApplyResult> {
  const { siteId, spec, changesetId } = input;
  const events: EntityEventInput[] = [];

  const result = await prisma.$transaction(
    async (tx) => {
      const plan = await planSetup(tx, siteId, spec);
      if (planFingerprint(plan) !== planFingerprint(input.reviewedPlan)) {
        throw new SetupApplyError(
          "STALE",
          "The plant changed since this changeset was planned. Review it again.",
          plan,
        );
      }
      if (!plan.applicable) {
        throw new SetupApplyError("NOT_APPLICABLE", "Resolve the changeset's problems before applying it.", plan);
      }
      const options = { tx, events };
      const written = { materials: {} as Record<string, string>, products: {} as Record<string, string> };

      for (const row of plan.rows.filter((r) => r.entity === "material")) {
        const source = spec.materials[row.index];
        if (!source) throw new SetupApplyError("WRITE_FAILED", `Material ${row.key} is missing from the spec`);
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
        } else if (row.action === "update" && id) {
          unwrapWrite(await materialService.update(id, fields, options), `Material ${row.key}`);
        }
        if (!id) throw new SetupApplyError("WRITE_FAILED", `Material ${row.key} has no record`);
        written.materials[row.key] = id;
        await upsertRef(
          tx,
          { siteId, entityType: "MATERIAL", source: spec.source, key: row.key, entityId: id },
          changesetId,
        );
      }

      for (const row of plan.rows.filter((r) => r.entity === "product")) {
        const source = spec.products[row.index];
        if (!source) throw new SetupApplyError("WRITE_FAILED", `Product ${row.key} is missing from the spec`);
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
        } else if (row.action === "update" && id && row.changes.length > 0) {
          unwrapWrite(await productService.update(id, fields, options), `Product ${row.key}`);
        }
        if (!id) throw new SetupApplyError("WRITE_FAILED", `Product ${row.key} has no record`);
        written.products[row.key] = id;

        for (const link of row.links ?? []) {
          if (link.action === "unchanged") continue;
          const linkSpec = (source.materials ?? []).find((m) => m.material === link.materialKey);
          const materialId = link.materialId ?? written.materials[link.materialKey];
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
        }
        await upsertRef(
          tx,
          { siteId, entityType: "PRODUCT", source: spec.source, key: row.key, entityId: id },
          changesetId,
        );
      }

      return { written, plan };
    },
    // A large import writes thousands of rows; the default 5s would cut it off.
    { timeout: 120_000, maxWait: 10_000 },
  );

  for (const event of events) publishEntityEvent(event);
  return result;
}
