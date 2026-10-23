import { z } from "zod";

// The setup spec: what an agent (or a person) proposes to bring into a plant.
// Records reference each other by key, never by id, so a spec built from a
// spreadsheet stays valid across plants and re-runs. `source` names the
// system the keys come from ("customer-erp"); a key resolves through the
// plant's external refs first, then by the record's natural key.

export const MAX_SETUP_ROWS = 2000;

const weightUnits = z.enum(["KG", "LB", "G", "OZ"]);
const key = z.string().trim().min(1).max(200);
const text = z.string().trim().max(2000);

export const setupMaterialSchema = z.object({
  key: key.describe("The material's key in the source system"),
  materialNumber: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Plant material number; defaults to key. Also how an existing material is found without an external ref"),
  name: text.optional(),
  shortCode: z.string().trim().max(50).optional(),
  description: text.optional(),
  externalNumber: z.string().trim().max(200).optional(),
  weightUnits: weightUnits.optional().describe("Unit the material is stocked in; omit for untracked materials"),
  unitCost: z.number().nonnegative().optional(),
});

export const setupProductMaterialSchema = z.object({
  material: key.describe("Key of a material in this spec, or of one the plant already has (by ref or material number)"),
  weight: z.number().nonnegative().optional().describe("Material used per part"),
  weightUnits: weightUnits.optional(),
  itemCost: z.number().nonnegative().optional(),
});

export const setupProductSchema = z.object({
  key: key.describe("The product's key in the source system"),
  sku: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Plant SKU; defaults to key. Also how an existing product is found without an external ref"),
  name: text.optional(),
  description: text.optional(),
  externalSku: z.string().trim().max(200).optional(),
  weight: z.number().nonnegative().optional().describe("Part weight"),
  weightUnits: weightUnits.optional(),
  itemCost: z.number().nonnegative().optional(),
  materials: z
    .array(setupProductMaterialSchema)
    .max(50)
    .optional()
    .describe("Bill of materials. Listed links are added or updated; links not listed are left alone"),
});

export const setupSpecSchema = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("Stable name of the system the keys come from, e.g. customer-erp. Reuse it on every run"),
  materials: z.array(setupMaterialSchema).max(MAX_SETUP_ROWS).default([]),
  products: z.array(setupProductSchema).max(MAX_SETUP_ROWS).default([]),
});

export type SetupSpec = z.output<typeof setupSpecSchema>;
export type SetupMaterial = z.output<typeof setupMaterialSchema>;
export type SetupProduct = z.output<typeof setupProductSchema>;

export function specRowCount(spec: SetupSpec): number {
  return spec.materials.length + spec.products.length;
}

/** JSON Schema plus field notes, for an agent mapping spreadsheet columns. */
export function setupSchemaDocument() {
  const { $schema: _schema, ...schema } = z.toJSONSchema(setupSpecSchema, { io: "input" }) as Record<string, unknown>;
  return {
    schema,
    order: ["materials", "products"],
    maxRows: MAX_SETUP_ROWS,
    notes: [
      "Fields left out are left unchanged on existing records; they are never cleared.",
      "Keys resolve through this source's external refs first, then by natural key (material number, SKU).",
      "A product's materials may reference materials in the same spec or ones the plant already has.",
      "Propose references exactly as the source has them. An unknown material comes back as an UNKNOWN_MATERIAL issue for the person to settle; never swap in a similar key.",
      `Propose at most ${MAX_SETUP_ROWS} rows per changeset; split bigger imports and propose materials before the products that use them.`,
      "Proposing never changes the plant. A person reviews and applies the changeset in IMM.",
    ],
  };
}
