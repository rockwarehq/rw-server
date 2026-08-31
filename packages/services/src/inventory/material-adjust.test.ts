import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import { balance } from "./material-balance.js";
import { adjust, create } from "./material-ledger.js";

// Integration tests (stock-adjustment.test.ts conventions): require
// DATABASE_URL and run against the real schema with an isolated fixture graph.

describe.skipIf(!process.env.DATABASE_URL)("material stock adjustments", () => {
  let siteId: string;
  let otherSiteId: string;
  let materialId: string;
  let unitlessMaterialId: string;

  async function createMaterial(site: string, weightUnits: "KG" | null) {
    const material = await prisma.material.create({ data: { siteId: site } });
    const version = await prisma.materialVersion.create({
      data: {
        materialId: material.id,
        version: 1,
        materialNumber: `MAT-${randomUUID().slice(0, 8)}`,
        weightUnits,
      },
    });
    await prisma.material.update({ where: { id: material.id }, data: { currentVersionId: version.id } });
    return material.id;
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({
      data: { name: `MatAdj Test ${suffix}`, slug: `mat-adj-${suffix}` },
    });
    siteId = (await prisma.site.create({ data: { name: `MatAdj Site ${suffix}`, workspaceId: workspace.id } })).id;
    otherSiteId = (await prisma.site.create({ data: { name: `MatAdj Other ${suffix}`, workspaceId: workspace.id } }))
      .id;
    materialId = await createMaterial(siteId, "KG");
    unitlessMaterialId = await createMaterial(siteId, null);
  });

  test("set mode reconciles to the counted balance via an ADJUSTMENT delta", async () => {
    const receipt = await create({ siteId, materialId, kind: "RECEIPT", quantity: 10, unit: "KG" });
    expect("error" in receipt && receipt.error).toBeFalsy();

    const result = await adjust({
      siteId,
      materialId,
      mode: "set",
      countedQuantity: 7,
      note: "shelf count",
    });
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) return;
    expect(Number(result.data.entry.quantity)).toBe(-3);
    expect(result.data.entry.kind).toBe("ADJUSTMENT");
    expect(result.data.entry.unit).toBe("KG");
    expect(Number(result.data.resultingBalance)).toBe(7);

    const b = await balance(materialId);
    expect(Number(b.balance)).toBe(7);
    expect(Number(b.adjusted)).toBe(-3);
  });

  test("delta mode applies signed corrections; zero delta rejected, zero-delta count allowed", async () => {
    const up = await adjust({ siteId, materialId, mode: "delta", delta: 2 });
    expect("error" in up && up.error).toBeFalsy();
    const b = await balance(materialId);
    expect(Number(b.balance)).toBe(9);

    const zero = await adjust({ siteId, materialId, mode: "delta", delta: 0 });
    expect("code" in zero && zero.code).toBe("INVALID_QUANTITY");

    const confirming = await adjust({ siteId, materialId, mode: "set", countedQuantity: 9 });
    expect("error" in confirming && confirming.error).toBeFalsy();
    if ("error" in confirming) return;
    expect(Number(confirming.data.entry.quantity)).toBe(0);

    const negative = await adjust({ siteId, materialId, mode: "set", countedQuantity: -1 });
    expect("code" in negative && negative.code).toBe("INVALID_QUANTITY");
  });

  test("rejects unitless materials and cross-site materials", async () => {
    const noUnit = await adjust({ siteId, materialId: unitlessMaterialId, mode: "delta", delta: 1 });
    expect("code" in noUnit && noUnit.code).toBe("NO_CANONICAL_UNIT");

    const wrongSite = await adjust({ siteId: otherSiteId, materialId, mode: "delta", delta: 1 });
    expect("code" in wrongSite && wrongSite.code).toBe("SITE_MISMATCH");
  });
});
