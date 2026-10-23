import { z } from "zod";

import type { CsvTable } from "./csv.js";
import type { SetupIssue } from "./plan.js";
import { type SetupSpec, setupSpecSchema } from "./spec.js";

// Builds a setup spec from uploaded files and a column mapping. The agent
// says which column is which field; the server reads every row. So a large
// import never passes through the model, and no value is retyped on the way.
// Blank cells are left out (fields left out never change). A value that
// can't be read becomes an issue that names the file, line and column.

const column = z.string().trim().min(1).describe("A column header, exactly as in the file's first line");
const field = z
  .union([column, z.object({ column }), z.object({ value: z.union([z.string(), z.number()]) })])
  .describe('A column header, or { "value": ... } for the same value on every row');
const upload = z.uuid().describe("An upload id from setup_upload, with the file already sent");

export const setupFilesSchema = z.object({
  numbers: z
    .object({ decimal: z.enum([".", ","]).default(".") })
    .optional()
    .describe('How numbers are written. decimal "," for 1.234,5; "." (default) for 1,234.5'),
  materials: z
    .object({
      upload,
      columns: z.object({
        key: field,
        materialNumber: field.optional(),
        name: field.optional(),
        shortCode: field.optional(),
        description: field.optional(),
        externalNumber: field.optional(),
        weightUnits: field.optional(),
        unitCost: field.optional(),
      }),
    })
    .optional(),
  products: z
    .object({
      upload,
      columns: z.object({
        key: field,
        sku: field.optional(),
        name: field.optional(),
        description: field.optional(),
        externalSku: field.optional(),
        weight: field.optional(),
        weightUnits: field.optional(),
        itemCost: field.optional(),
      }),
      materials: z
        .array(
          z.object({
            material: field,
            weight: field.optional(),
            weightUnits: field.optional(),
            itemCost: field.optional(),
          }),
        )
        .max(20)
        .optional()
        .describe("Bill of materials laid out as columns on the product row, one entry per material column group"),
    })
    .optional(),
  bom: z
    .object({
      upload,
      columns: z.object({
        product: field,
        material: field,
        weight: field.optional(),
        weightUnits: field.optional(),
        itemCost: field.optional(),
      }),
    })
    .optional()
    .describe("Bill of materials as its own file, one row per product and material. Products must be in this import"),
});

export type SetupFiles = z.output<typeof setupFilesSchema>;
type Field = z.output<typeof field>;

/** Where each spec row came from, kept with the changeset so plans can point at file lines. */
export interface SetupOrigin {
  files: string[];
  material: Array<[file: number, line: number]>;
  product: Array<[file: number, line: number]>;
  /** Per product index, where each of its material links came from. */
  links: Record<number, Array<[file: number, line: number]>>;
}

export class SetupMappingError extends Error {}

const UNITS: Record<string, "KG" | "LB" | "G" | "OZ"> = {
  kg: "KG",
  kgs: "KG",
  kilo: "KG",
  kilos: "KG",
  kilogram: "KG",
  kilograms: "KG",
  lb: "LB",
  lbs: "LB",
  pound: "LB",
  pounds: "LB",
  "#": "LB",
  g: "G",
  gr: "G",
  grs: "G",
  gm: "G",
  gms: "G",
  gram: "G",
  grams: "G",
  oz: "OZ",
  ounce: "OZ",
  ounces: "OZ",
};

type Uploaded = { filename: string; table: CsvTable };

export function specFromFiles(
  source: string,
  mapping: SetupFiles,
  files: Map<string, Uploaded>,
): { spec: SetupSpec; origin: SetupOrigin; issues: SetupIssue[] } {
  const decimal = mapping.numbers?.decimal ?? ".";
  const issues: SetupIssue[] = [];
  const origin: SetupOrigin = { files: [], material: [], product: [], links: {} };

  function open(id: string, role: string) {
    const file = files.get(id);
    if (!file) throw new SetupMappingError(`The ${role} upload ${id} wasn't found, has expired, or has no file yet.`);
    let fileIndex = origin.files.indexOf(file.filename);
    if (fileIndex < 0) fileIndex = origin.files.push(file.filename) - 1;
    const headers = file.table.headers;
    /** A field's reader for one row, checked against the headers up front. */
    const reader = (spec: Field | undefined, name: string) => {
      if (spec === undefined) return () => undefined;
      if (typeof spec === "object" && "value" in spec) return () => String(spec.value);
      const header = typeof spec === "string" ? spec : spec.column;
      let at = headers.indexOf(header);
      if (at < 0) {
        const loose = headers.flatMap((h, i) => (h.toLowerCase() === header.toLowerCase() ? [i] : []));
        if (loose.length === 1) at = loose[0] as number;
      }
      if (at < 0) {
        throw new SetupMappingError(
          `${file.filename} has no column "${header}" (mapped to ${role} ${name}). Its columns are: ${headers.map((h) => `"${h}"`).join(", ")}.`,
        );
      }
      return (cells: string[]) => {
        const value = (cells[at] ?? "").trim();
        return value === "" ? undefined : value;
      };
    };
    return { file, fileIndex, reader };
  }

  /** Where an issue is, for people (path) and for pinning it to its row (at). */
  function where(file: Uploaded, line: number, what: string) {
    return { path: `${file.filename} line ${line}, ${what}`, at: { file: file.filename, line, column: what } };
  }

  function number(raw: string | undefined, file: Uploaded, line: number, what: string): number | undefined {
    if (raw === undefined) return undefined;
    let text = raw.replace(/[\s$€£¥]/g, "");
    text = decimal === "," ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
    const value = Number(text);
    if (text === "" || !Number.isFinite(value) || value < 0) {
      issues.push({
        code: "BAD_VALUE",
        ...where(file, line, what),
        message: `"${raw}" isn't a number of zero or more.`,
        hint:
          decimal === "." && /,\d{1,2}$/.test(raw)
            ? 'If the file writes decimals with a comma, set numbers.decimal to ",".'
            : undefined,
      });
      return undefined;
    }
    return value;
  }

  function units(raw: string | undefined, file: Uploaded, line: number, what: string) {
    if (raw === undefined) return undefined;
    const unit = UNITS[raw.toLowerCase().replace(/[.\s]/g, "")] ?? (["KG", "LB", "G", "OZ"].includes(raw) ? raw : null);
    if (!unit) {
      issues.push({
        code: "BAD_VALUE",
        ...where(file, line, what),
        message: `"${raw}" isn't a weight unit. Use KG, LB, G or OZ.`,
      });
      return undefined;
    }
    return unit as "KG" | "LB" | "G" | "OZ";
  }

  const spec: SetupSpec = { source, materials: [], products: [] };

  if (mapping.materials) {
    const { file, fileIndex, reader } = open(mapping.materials.upload, "materials");
    const c = mapping.materials.columns;
    const read = {
      key: reader(c.key, "key"),
      materialNumber: reader(c.materialNumber, "materialNumber"),
      name: reader(c.name, "name"),
      shortCode: reader(c.shortCode, "shortCode"),
      description: reader(c.description, "description"),
      externalNumber: reader(c.externalNumber, "externalNumber"),
      weightUnits: reader(c.weightUnits, "weightUnits"),
      unitCost: reader(c.unitCost, "unitCost"),
    };
    for (const { line, cells } of file.table.rows) {
      const key = read.key(cells);
      if (!key) {
        issues.push({ code: "BAD_VALUE", ...where(file, line, "key"), message: "This row has no key." });
        continue;
      }
      spec.materials.push({
        key,
        materialNumber: read.materialNumber(cells),
        name: read.name(cells),
        shortCode: read.shortCode(cells),
        description: read.description(cells),
        externalNumber: read.externalNumber(cells),
        weightUnits: units(read.weightUnits(cells), file, line, "weightUnits"),
        unitCost: number(read.unitCost(cells), file, line, "unitCost"),
      });
      origin.material.push([fileIndex, line]);
    }
  }

  const productIndex = new Map<string, number>();
  if (mapping.products) {
    const { file, fileIndex, reader } = open(mapping.products.upload, "products");
    const c = mapping.products.columns;
    const read = {
      key: reader(c.key, "key"),
      sku: reader(c.sku, "sku"),
      name: reader(c.name, "name"),
      description: reader(c.description, "description"),
      externalSku: reader(c.externalSku, "externalSku"),
      weight: reader(c.weight, "weight"),
      weightUnits: reader(c.weightUnits, "weightUnits"),
      itemCost: reader(c.itemCost, "itemCost"),
    };
    const linkReaders = (mapping.products.materials ?? []).map((link, i) => ({
      material: reader(link.material, `materials[${i}].material`),
      weight: reader(link.weight, `materials[${i}].weight`),
      weightUnits: reader(link.weightUnits, `materials[${i}].weightUnits`),
      itemCost: reader(link.itemCost, `materials[${i}].itemCost`),
    }));
    for (const { line, cells } of file.table.rows) {
      const key = read.key(cells);
      if (!key) {
        issues.push({ code: "BAD_VALUE", ...where(file, line, "key"), message: "This row has no key." });
        continue;
      }
      const index = spec.products.length;
      const links = linkReaders.flatMap((link, i) => {
        const material = link.material(cells);
        if (!material) return [];
        return [
          {
            material,
            weight: number(link.weight(cells), file, line, `materials[${i}].weight`),
            weightUnits: units(link.weightUnits(cells), file, line, `materials[${i}].weightUnits`),
            itemCost: number(link.itemCost(cells), file, line, `materials[${i}].itemCost`),
          },
        ];
      });
      spec.products.push({
        key,
        sku: read.sku(cells),
        name: read.name(cells),
        description: read.description(cells),
        externalSku: read.externalSku(cells),
        weight: number(read.weight(cells), file, line, "weight"),
        weightUnits: units(read.weightUnits(cells), file, line, "weightUnits"),
        itemCost: number(read.itemCost(cells), file, line, "itemCost"),
        ...(links.length ? { materials: links } : {}),
      });
      origin.product.push([fileIndex, line]);
      if (links.length) origin.links[index] = links.map(() => [fileIndex, line]);
      if (!productIndex.has(key)) productIndex.set(key, index);
    }
  }

  if (mapping.bom) {
    const { file, fileIndex, reader } = open(mapping.bom.upload, "bom");
    const c = mapping.bom.columns;
    const read = {
      product: reader(c.product, "product"),
      material: reader(c.material, "material"),
      weight: reader(c.weight, "weight"),
      weightUnits: reader(c.weightUnits, "weightUnits"),
      itemCost: reader(c.itemCost, "itemCost"),
    };
    for (const { line, cells } of file.table.rows) {
      const productKey = read.product(cells);
      const material = read.material(cells);
      if (!productKey || !material) {
        issues.push({
          code: "BAD_VALUE",
          ...where(file, line, productKey ? "material" : "product"),
          message: "This row needs both a product and a material.",
        });
        continue;
      }
      const index = productIndex.get(productKey);
      const product = index === undefined ? undefined : spec.products[index];
      if (index === undefined || !product) {
        issues.push({
          code: "UNKNOWN_PRODUCT",
          ...where(file, line, "product"),
          message: `Product ${productKey} isn't in this import's products.`,
          hint: "Add the product to the products file, or leave its bill of materials for a later import.",
        });
        continue;
      }
      const materials = product.materials ?? [];
      if (materials.some((m) => m.material === material)) {
        issues.push({
          code: "DUPLICATE_KEY",
          ...where(file, line, "material"),
          message: `Product ${productKey} already lists material ${material}.`,
        });
        continue;
      }
      materials.push({
        material,
        weight: number(read.weight(cells), file, line, "weight"),
        weightUnits: units(read.weightUnits(cells), file, line, "weightUnits"),
        itemCost: number(read.itemCost(cells), file, line, "itemCost"),
      });
      product.materials = materials;
      origin.links[index] = [...(origin.links[index] ?? []), [fileIndex, line]];
    }
  }

  // Lengths and the like: the same rules as an inline spec, reported by line.
  const checked = setupSpecSchema.safeParse(spec);
  if (!checked.success) {
    for (const problem of checked.error.issues.slice(0, 200)) {
      const [entity, index, ...rest] = problem.path;
      const at =
        entity === "materials" && typeof index === "number"
          ? origin.material[index]
          : entity === "products" && typeof index === "number"
            ? origin.product[index]
            : undefined;
      issues.push({
        code: "BAD_VALUE",
        path: at ? `${origin.files[at[0]]} line ${at[1]}, ${rest.join(".")}` : problem.path.join("."),
        message: problem.message,
      });
    }
    return { spec, origin, issues };
  }
  return { spec: checked.data, origin, issues };
}

/** The file mapping as an agent reads it in setup_schema. */
export function filesSchemaDocument() {
  const { $schema: _schema, ...schema } = z.toJSONSchema(setupFilesSchema, { io: "input" }) as Record<string, unknown>;
  return {
    schema,
    notes: [
      "For more than a few rows, or any spreadsheet: send each CSV with setup_upload, then propose with source and files. You map columns; Rockware reads every row, so values arrive exactly as in the file.",
      "Map each field to a column header exactly as in the file's first line, or to { value } for a constant such as a unit the file doesn't state.",
      "Blank cells are left out, and fields left out never change existing records.",
      "Bill of materials: either material column groups on the product row (products.materials), or a separate file with one row per product and material (bom).",
      'Weight units read KG, LB, G or OZ, and common spellings (kgs, lbs, grams). Numbers may carry currency signs and thousands separators; set numbers.decimal to "," when the file writes 1.234,5.',
      "Values that can't be read are reported with their file, line and column. Fix the file, upload it again and propose again.",
    ],
  };
}
