import type { Prisma } from "@rw/db";

import { MAX_SETUP_ROWS, type SetupMaterial, type SetupProduct, type SetupSpec, specRowCount } from "./spec.js";

// Plans a setup spec against the plant: resolves every key, diffs each record
// against what is there, and reports what applying would do. Pure reads, run
// through whatever client it is given, so apply can replan inside its own
// transaction and refuse when the plant moved since the person reviewed it.

type Db = Prisma.TransactionClient;

export type SetupAction = "create" | "update" | "unchanged" | "conflict";
export type SetupEntityKind = "material" | "product";

export interface SetupIssue {
  code:
    | "DUPLICATE_KEY"
    | "UNKNOWN_MATERIAL"
    | "AMBIGUOUS_MATCH"
    | "DELETED_MATCH"
    | "TOO_LARGE"
    | "DUPLICATE_NATURAL_KEY"
    | "BAD_VALUE"
    | "UNKNOWN_PRODUCT";
  /** Where in the spec, e.g. products[12].materials[0].material, or a file line for uploaded imports. */
  path: string;
  message: string;
  hint?: string;
  /** The file line the issue is about, for imports built from uploaded files. */
  at?: SetupOriginRef;
}

export interface SetupOriginRef {
  file: string;
  line: number;
}

export interface SetupChange {
  field: string;
  from: string | number | null;
  to: string | number | null;
}

export interface SetupLinkPlan {
  materialKey: string;
  materialName: string;
  /** Existing material id, or null when the material is created by this changeset. */
  materialId: string | null;
  action: "create" | "update" | "unchanged";
  changes: SetupChange[];
}

export interface SetupRow {
  entity: SetupEntityKind;
  index: number;
  key: string;
  /** What a person recognizes: name, else material number / SKU. */
  label: string;
  action: SetupAction;
  /** The existing record this row updates (null for creates). */
  entityId: string | null;
  /** How it was found: an external ref, its natural key, or not at all. */
  matchedBy: "ref" | "natural" | null;
  changes: SetupChange[];
  links?: SetupLinkPlan[];
  issues: SetupIssue[];
  /** The file line this row came from, for imports built from uploaded files. */
  origin?: SetupOriginRef;
}

export interface SetupPlan {
  source: string;
  rows: SetupRow[];
  /** Spec-level problems (size and the like). */
  issues: SetupIssue[];
  summary: Record<SetupEntityKind, Record<SetupAction, number>>;
  /** No conflicts and no issues: it can be applied as is. */
  applicable: boolean;
}

const emptyCounts = (): Record<SetupAction, number> => ({ create: 0, update: 0, unchanged: 0, conflict: 0 });

type Scalar = string | number | null;

function toScalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  // Prisma.Decimal and friends
  const asNumber = Number(String(value));
  return Number.isFinite(asNumber) ? asNumber : String(value);
}

function same(a: Scalar, b: Scalar): boolean {
  if (typeof a === "number" || typeof b === "number") return a !== null && b !== null && Number(a) === Number(b);
  return (a ?? null) === (b ?? null);
}

/** Changes for the fields the spec sets; fields left out never change. */
function diff(current: Record<string, unknown> | null, proposed: Record<string, unknown>): SetupChange[] {
  const changes: SetupChange[] = [];
  for (const [field, value] of Object.entries(proposed)) {
    if (value === undefined) continue;
    const from = current ? toScalar(current[field]) : null;
    const to = toScalar(value);
    if (!current || !same(from, to)) changes.push({ field, from, to });
  }
  return changes;
}

function duplicates(keys: string[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return dupes;
}

interface Found {
  id: string;
  deleted: boolean;
  current: Record<string, unknown> | null;
}

async function refsFor(db: Db, siteId: string, entityType: "MATERIAL" | "PRODUCT", source: string, keys: string[]) {
  const rows = await db.externalRef.findMany({
    where: { siteId, entityType, source, key: { in: keys } },
    select: { key: true, entityId: true },
  });
  return new Map(rows.map((row) => [row.key, row.entityId]));
}

async function materialsByIdOrNumber(db: Db, siteId: string, ids: string[], numbers: string[]) {
  const rows = await db.material.findMany({
    where: {
      siteId,
      OR: [{ id: { in: ids } }, { currentVersion: { materialNumber: { in: numbers } } }],
    },
    select: { id: true, deletedAt: true, currentVersion: true },
  });
  const byId = new Map<string, Found>();
  const byNumber = new Map<string, Found[]>();
  for (const row of rows) {
    const found = { id: row.id, deleted: row.deletedAt !== null, current: row.currentVersion };
    byId.set(row.id, found);
    const number = row.currentVersion?.materialNumber;
    if (number && !found.deleted) byNumber.set(number, [...(byNumber.get(number) ?? []), found]);
  }
  return { byId, byNumber };
}

async function productsByIdOrSku(db: Db, siteId: string, ids: string[], skus: string[]) {
  const rows = await db.product.findMany({
    where: { siteId, OR: [{ id: { in: ids } }, { currentVersion: { sku: { in: skus } } }] },
    select: { id: true, deletedAt: true, currentVersion: true },
  });
  const byId = new Map<string, Found>();
  const bySku = new Map<string, Found[]>();
  for (const row of rows) {
    const found = { id: row.id, deleted: row.deletedAt !== null, current: row.currentVersion };
    byId.set(row.id, found);
    const sku = row.currentVersion?.sku;
    if (sku && !found.deleted) bySku.set(sku, [...(bySku.get(sku) ?? []), found]);
  }
  return { byId, bySku };
}

/** Resolve one row: its ref first, then its natural key. */
function resolve(
  path: string,
  refId: string | undefined,
  byId: Map<string, Found>,
  natural: Found[] | undefined,
  naturalLabel: string,
): { found: Found | null; matchedBy: SetupRow["matchedBy"]; issue?: SetupIssue } {
  if (refId) {
    const found = byId.get(refId);
    if (found && !found.deleted) return { found, matchedBy: "ref" };
    if (found?.deleted) {
      return {
        found: null,
        matchedBy: null,
        issue: {
          code: "DELETED_MATCH",
          path,
          message: `This key was imported before, but that record has since been deleted.`,
          hint: "Restore it in IMM, or use a new key to create a fresh record.",
        },
      };
    }
  }
  if (natural && natural.length > 1) {
    return {
      found: null,
      matchedBy: null,
      issue: {
        code: "AMBIGUOUS_MATCH",
        path,
        message: `${natural.length} records in the plant already have ${naturalLabel}.`,
        hint: "Rename the duplicates in IMM so only one matches, then propose again.",
      },
    };
  }
  if (natural?.length === 1) return { found: natural[0], matchedBy: "natural" };
  return { found: null, matchedBy: null };
}

function materialFields(row: SetupMaterial) {
  return {
    materialNumber: row.materialNumber ?? row.key,
    name: row.name,
    shortCode: row.shortCode,
    description: row.description,
    externalNumber: row.externalNumber,
    weightUnits: row.weightUnits,
    unitCost: row.unitCost,
  };
}

function productFields(row: SetupProduct) {
  return {
    sku: row.sku ?? row.key,
    name: row.name,
    description: row.description,
    externalSku: row.externalSku,
    weight: row.weight,
    weightUnits: row.weightUnits,
    itemCost: row.itemCost,
  };
}

export async function planSetup(db: Db, siteId: string, spec: SetupSpec): Promise<SetupPlan> {
  const summary = { material: emptyCounts(), product: emptyCounts() };
  const issues: SetupIssue[] = [];
  if (specRowCount(spec) > MAX_SETUP_ROWS) {
    issues.push({
      code: "TOO_LARGE",
      path: "",
      message: `This changeset has ${specRowCount(spec)} rows; the limit is ${MAX_SETUP_ROWS}.`,
      hint: "Split it: propose materials first, then products in chunks.",
    });
    return { source: spec.source, rows: [], issues, summary, applicable: false };
  }

  const rows: SetupRow[] = [];
  const count = (row: SetupRow) => {
    summary[row.entity][row.action] += 1;
    rows.push(row);
  };

  // ── Materials ────────────────────────────────────────────────────────────
  const materialKeys = spec.materials.map((m) => m.key);
  const dupeMaterials = duplicates(materialKeys);
  const dupeNumbers = duplicates(spec.materials.map((m) => m.materialNumber ?? m.key));
  const linkKeys = spec.products.flatMap((p) => (p.materials ?? []).map((link) => link.material));
  const materialRefs = await refsFor(db, siteId, "MATERIAL", spec.source, [...materialKeys, ...linkKeys]);
  const materials = await materialsByIdOrNumber(
    db,
    siteId,
    [...materialRefs.values()],
    [...spec.materials.map((m) => m.materialNumber ?? m.key), ...linkKeys],
  );

  /** Material key → how products should reference it. */
  const materialTargets = new Map<string, { id: string | null; name: string }>();

  spec.materials.forEach((material, index) => {
    const path = `materials[${index}]`;
    const fields = materialFields(material);
    const label = material.name ?? fields.materialNumber;
    const rowIssues: SetupIssue[] = [];
    if (dupeMaterials.has(material.key)) {
      rowIssues.push({ code: "DUPLICATE_KEY", path, message: `Key ${material.key} appears more than once.` });
    }
    if (dupeNumbers.has(fields.materialNumber)) {
      rowIssues.push({
        code: "DUPLICATE_NATURAL_KEY",
        path,
        message: `Material number ${fields.materialNumber} appears more than once.`,
      });
    }
    const resolved = resolve(
      path,
      materialRefs.get(material.key),
      materials.byId,
      materials.byNumber.get(fields.materialNumber),
      `material number ${fields.materialNumber}`,
    );
    if (resolved.issue) rowIssues.push(resolved.issue);
    const changes = diff(resolved.found?.current ?? null, fields);
    const action: SetupAction =
      rowIssues.length > 0 ? "conflict" : !resolved.found ? "create" : changes.length ? "update" : "unchanged";
    materialTargets.set(material.key, { id: resolved.found?.id ?? null, name: label });
    count({
      entity: "material",
      index,
      key: material.key,
      label,
      action,
      entityId: resolved.found?.id ?? null,
      matchedBy: resolved.matchedBy,
      changes: action === "conflict" ? [] : changes,
      issues: rowIssues,
    });
  });

  // ── Products ─────────────────────────────────────────────────────────────
  const productKeys = spec.products.map((p) => p.key);
  const dupeProducts = duplicates(productKeys);
  const dupeSkus = duplicates(spec.products.map((p) => p.sku ?? p.key));
  const productRefs = await refsFor(db, siteId, "PRODUCT", spec.source, productKeys);
  const products = await productsByIdOrSku(
    db,
    siteId,
    [...productRefs.values()],
    spec.products.map((p) => p.sku ?? p.key),
  );

  const existingProductIds = [...products.byId.keys()];
  const existingLinks = existingProductIds.length
    ? await db.productMaterial.findMany({
        where: { productId: { in: existingProductIds } },
        select: { productId: true, materialId: true, currentVersion: true },
      })
    : [];
  const linkOf = new Map(existingLinks.map((link) => [`${link.productId}:${link.materialId}`, link.currentVersion]));

  spec.products.forEach((product, index) => {
    const path = `products[${index}]`;
    const fields = productFields(product);
    const label = product.name ?? fields.sku;
    const rowIssues: SetupIssue[] = [];
    if (dupeProducts.has(product.key)) {
      rowIssues.push({ code: "DUPLICATE_KEY", path, message: `Key ${product.key} appears more than once.` });
    }
    if (dupeSkus.has(fields.sku)) {
      rowIssues.push({ code: "DUPLICATE_NATURAL_KEY", path, message: `SKU ${fields.sku} appears more than once.` });
    }
    const resolved = resolve(
      path,
      productRefs.get(product.key),
      products.byId,
      products.bySku.get(fields.sku),
      `SKU ${fields.sku}`,
    );
    if (resolved.issue) rowIssues.push(resolved.issue);

    const links: SetupLinkPlan[] = [];
    (product.materials ?? []).forEach((link, linkIndex) => {
      const linkPath = `${path}.materials[${linkIndex}].material`;
      let target = materialTargets.get(link.material);
      if (!target) {
        const refId = materialRefs.get(link.material);
        const existing = refId ? materials.byId.get(refId) : undefined;
        const byNumber = materials.byNumber.get(link.material);
        const found = existing && !existing.deleted ? existing : byNumber?.length === 1 ? byNumber[0] : undefined;
        if (found) {
          const current = found.current as { name?: string | null; materialNumber?: string } | null;
          target = { id: found.id, name: current?.name ?? current?.materialNumber ?? link.material };
        }
      }
      if (!target) {
        rowIssues.push({
          code: "UNKNOWN_MATERIAL",
          path: linkPath,
          message: `No material ${link.material} in this changeset or the plant.`,
          hint: "Add it to materials in this changeset, or apply the changeset that creates it first.",
        });
        return;
      }
      const proposed = { weight: link.weight, weightUnits: link.weightUnits, itemCost: link.itemCost };
      const current =
        resolved.found && target.id ? (linkOf.get(`${resolved.found.id}:${target.id}`) ?? undefined) : undefined;
      const changes = diff(current ?? null, proposed);
      links.push({
        materialKey: link.material,
        materialName: target.name,
        materialId: target.id,
        action: !current ? "create" : changes.length ? "update" : "unchanged",
        changes,
      });
    });

    const changes = diff(resolved.found?.current ?? null, fields);
    const linksChange = links.some((link) => link.action !== "unchanged");
    const action: SetupAction =
      rowIssues.length > 0
        ? "conflict"
        : !resolved.found
          ? "create"
          : changes.length || linksChange
            ? "update"
            : "unchanged";
    count({
      entity: "product",
      index,
      key: product.key,
      label,
      action,
      entityId: resolved.found?.id ?? null,
      matchedBy: resolved.matchedBy,
      changes: action === "conflict" ? [] : changes,
      links,
      issues: rowIssues,
    });
  });

  // A material conflict makes every product that links it unapplicable too.
  const applicable = issues.length === 0 && rows.every((row) => row.action !== "conflict");
  return { source: spec.source, rows, issues, summary, applicable };
}

/**
 * What apply compares: did anything the person reviewed change? Built from
 * arrays only, because the stored plan comes back from jsonb with its object
 * keys re-sorted.
 */
export function planFingerprint(plan: SetupPlan): string {
  const changes = (list: SetupChange[]) => list.map((change) => [change.field, change.from, change.to]);
  return JSON.stringify(
    plan.rows.map((row) => [
      row.entity,
      row.key,
      row.action,
      row.entityId,
      changes(row.changes),
      (row.links ?? []).map((link) => [link.materialKey, link.materialId, link.action, changes(link.changes)]),
    ]),
  );
}
