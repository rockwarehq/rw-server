import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { material, inventory, product, materialLedger } from "@rw/services/inventory/index";
import { storageConfig } from "../config.js";
import { type CodeOverrides, throwServiceError, unwrap } from "./errors.js";

// Historical mappings that predate the shared mapper — pinned because
// observable error codes are API (@rockwarehq/rpc-client is published):
// - MATERIAL_DELETED reads as absent like the other *_DELETED codes, but is
//   not in the shared exact table (default would be BAD_REQUEST).
// - NO_CURRENT_BLOB always fell through to the catch-all BAD_REQUEST in this
//   router (shared default: CONFLICT).
const inventoryOverrides: CodeOverrides = {
  MATERIAL_DELETED: "NOT_FOUND",
  NO_CURRENT_BLOB: "BAD_REQUEST",
};

// ============================================================================
// Input Schemas - Inventory
// ============================================================================

const inventoryListInputSchema = z.object({
  siteId: z.uuid().optional(),
  cycleId: z.uuid().optional(),
  productBlobId: z.uuid().optional(),
  jobProductBlobId: z.uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const cycleIdInputSchema = z.object({
  cycleId: z.uuid(),
});

// ============================================================================
// Input Schemas - Material
// ============================================================================

const materialCreateInputSchema = z.object({
  siteId: z.uuid(),
  materialNumber: z.string().min(1),
  name: z.string().optional(),
  shortCode: z.string().optional(),
  description: z.string().optional(),
  externalNumber: z.string().optional(),
  weightUnits: z.enum(["KG", "LB", "G", "OZ"]).nullish(),
  unitCost: z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).nullish(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const materialUpdateInputSchema = z.object({
  id: z.uuid(),
  materialNumber: z.string().min(1).optional(),
  name: z.string().optional(),
  shortCode: z.string().optional(),
  description: z.string().optional(),
  externalNumber: z.string().optional(),
  weightUnits: z.enum(["KG", "LB", "G", "OZ"]).nullish(),
  unitCost: z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).nullish(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const materialListInputSchema = z.object({
  siteId: z.uuid().optional(),
  q: z.string().optional(),
  name: z.string().optional(),
  materialNumber: z.string().optional(),
  shortCode: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures - Inventory
// ============================================================================

/**
 * List inventory items with optional filters
 */
export const inventoryList = authRequired.input(inventoryListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return inventory.list(input);
});

/**
 * Get inventory item by ID
 */
export const inventoryGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await inventory.getById(input.id), { notFoundMessage: "Inventory item not found" });
});

/**
 * Get all inventory items from a specific cycle
 */
export const inventoryGetByCycle = authRequired.input(cycleIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await inventory.getByCycle(input.cycleId));
});

// ============================================================================
// Procedures - Material
// ============================================================================

/**
 * Create a new material
 */
export const materialCreate = authRequired.input(materialCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await material.create(input));
});

/**
 * List materials with optional filters
 */
export const materialList = authRequired.input(materialListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return material.list(input);
});

/**
 * Get material by ID
 */
export const materialGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return unwrap(await material.getById(input.id), {
    notFoundMessage: "Material not found",
    overrides: inventoryOverrides,
  });
});

/**
 * Update material (creates new blob version)
 */
export const materialUpdate = authRequired.input(materialUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { id, ...updateData } = input;
  return unwrap(await material.update(id, updateData), { overrides: inventoryOverrides });
});

/**
 * Delete material (soft delete)
 */
export const materialRemove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await material.remove(input.id);
  if (result.error) throwServiceError(result, inventoryOverrides);
  return { success: true };
});

// ============================================================================
// Input Schemas - Product
// ============================================================================

const weightUnitSchema = z.enum(["KG", "LB", "G", "OZ"]);

const productCreateInputSchema = z.object({
  siteId: z.uuid(),
  sku: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  externalSku: z.string().optional(),
  weight: z.number().nonnegative().nullish(),
  weightUnits: weightUnitSchema.optional(),
  itemCost: z.number().nonnegative().nullish(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const productUpdateInputSchema = z.object({
  id: z.uuid(),
  sku: z.string().min(1).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  externalSku: z.string().optional(),
  weight: z.number().nonnegative().nullish(),
  weightUnits: weightUnitSchema.optional(),
  itemCost: z.number().nonnegative().nullish(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const productListInputSchema = z.object({
  siteId: z.uuid().optional(),
  q: z.string().optional(),
  sku: z.string().optional(),
  name: z.string().optional(),
  includeArchived: z.boolean().default(false),
  archivedOnly: z.boolean().default(false),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const productDuplicateInputSchema = z.object({
  id: z.uuid(),
  sku: z.string().min(1),
  name: z.string().optional(),
});

// Material management schemas
const productAddMaterialInputSchema = z.object({
  productId: z.uuid(),
  materialId: z.uuid(),
  weight: z.number().nonnegative().nullish(),
  weightUnits: weightUnitSchema.optional(),
  itemCost: z.number().nonnegative().nullish(),
});

const productUpdateMaterialInputSchema = z.object({
  productId: z.uuid(),
  materialId: z.uuid(),
  weight: z.number().nonnegative().nullish(),
  weightUnits: weightUnitSchema.optional(),
  itemCost: z.number().nonnegative().nullish(),
});

const productRemoveMaterialInputSchema = z.object({
  productId: z.uuid(),
  materialId: z.uuid(),
  /** Required when removing the active of a multi-member alt group. */
  replaceActiveWithProductMaterialId: z.uuid().optional(),
});

const productIdInputSchema = z.object({
  productId: z.uuid(),
});

// Picture management schemas
const productAddPictureInputSchema = z.object({
  productId: z.uuid(),
  filename: z.string().min(1),
  contentType: z.string().refine((ct) => storageConfig.allowedContentTypes.includes(ct), {
    message: `Content type must be one of: ${storageConfig.allowedContentTypes.join(", ")}`,
  }),
  size: z
    .number()
    .int()
    .positive()
    .max(storageConfig.maxFileSizeBytes, {
      message: `File size must not exceed ${storageConfig.maxFileSizeBytes / (1024 * 1024)}MB`,
    }),
});

const productRemovePictureInputSchema = z.object({
  productId: z.uuid(),
  pictureId: z.uuid(),
});

const productSetPrimaryPictureInputSchema = z.object({
  productId: z.uuid(),
  pictureId: z.uuid(),
});

// ============================================================================
// Procedures - Product CRUD
// ============================================================================

/**
 * Create a new product
 */
export const productCreate = authRequired.input(productCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return unwrap(await product.create(input));
});

/**
 * List products with optional filters
 */
export const productList = authRequired.input(productListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return product.list(input);
});

/**
 * Get product by ID with materials, pictures, and primary picture URL
 */
export const productGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return unwrap(await product.getById(input.id), { notFoundMessage: "Product not found" });
});

/**
 * Update product (creates new blob version)
 */
export const productUpdate = authRequired.input(productUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const { id, ...updateData } = input;
  return unwrap(await product.update(id, updateData), { overrides: inventoryOverrides });
});

/**
 * Delete product (soft delete)
 */
export const productRemove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});

// ============================================================================
// Procedures - Product Lifecycle
// ============================================================================

/**
 * Archive a product
 */
export const productArchive = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return unwrap(await product.archive(input.id));
});

/**
 * Unarchive a product
 */
export const productUnarchive = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return unwrap(await product.unarchive(input.id));
});

/**
 * Duplicate a product with a new SKU
 */
export const productDuplicate = authRequired.input(productDuplicateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return unwrap(await product.duplicate(input), { overrides: inventoryOverrides });
});

// ============================================================================
// Procedures - Product Materials
// ============================================================================

/**
 * Add a material to a product
 */
export const productAddMaterial = authRequired
  .input(productAddMaterialInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return unwrap(await product.addMaterial(input), { overrides: inventoryOverrides });
  });

/**
 * Update a product-material link
 */
export const productUpdateMaterial = authRequired
  .input(productUpdateMaterialInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return unwrap(await product.updateMaterial(input), { overrides: inventoryOverrides });
  });

/**
 * Remove a material from a product
 */
export const productRemoveMaterial = authRequired
  .input(productRemoveMaterialInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.removeMaterial(
      input.productId,
      input.materialId,
      input.replaceActiveWithProductMaterialId,
    );
    if (result.error) throwServiceError(result);
    return { success: true };
  });

/**
 * List materials for a product
 */
export const productListMaterials = authRequired.input(productIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return unwrap(await product.listMaterials(input.productId));
});

// ============================================================================
// Procedures - Product Pictures
// ============================================================================

/**
 * Add a picture to a product (returns presigned upload URL)
 */
export const productAddPicture = authRequired
  .input(productAddPictureInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return unwrap(await product.addPicture(input));
  });

/**
 * Remove a picture from a product
 */
export const productRemovePicture = authRequired
  .input(productRemovePictureInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.removePicture(input.productId, input.pictureId);
    if (result.error) throwServiceError(result);
    return { success: true };
  });

/**
 * Set a picture as the primary picture for a product
 */
export const productSetPrimaryPicture = authRequired
  .input(productSetPrimaryPictureInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.setPrimaryPicture(input.productId, input.pictureId);
    if (result.error) throwServiceError(result);
    return { success: true };
  });

/**
 * List pictures for a product with presigned download URLs
 */
export const productListPictures = authRequired.input(productIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return unwrap(await product.listPictures(input.productId));
});

// ============================================================================
// Input Schemas - ProductMaterial Alt Groups
// ============================================================================

const productMaterialIdInputSchema = z.object({
  productMaterialId: z.uuid(),
});

const removeFromAltGroupInputSchema = z.object({
  productMaterialId: z.uuid(),
  /** Required when removing the active from a multi-member group. */
  replaceActiveWithProductMaterialId: z.uuid().optional(),
});

const altGroupIdInputSchema = z.object({
  altGroupId: z.uuid(),
});

const addMaterialToAltGroupInputSchema = z.object({
  altGroupId: z.uuid(),
  materialId: z.uuid(),
});

const setAltGroupActiveInputSchema = z.object({
  altGroupId: z.uuid(),
  productMaterialId: z.uuid(),
});

const updateAltGroupLabelInputSchema = z.object({
  altGroupId: z.uuid(),
  label: z.string().max(120).nullable(),
});

// ============================================================================
// Procedures - ProductMaterial Alt Groups
// ============================================================================

/**
 * Create a new unnamed alternate group around an existing ProductMaterial,
 * placing it as the first and active member.
 */
export const productCreateAltGroup = authRequired
  .input(productMaterialIdInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return unwrap(await product.createAltGroup(input.productMaterialId));
  });

/**
 * Add a material to an alt group. If the material is already on the product,
 * moves the existing ProductMaterial into the group. Otherwise creates a new
 * ProductMaterial and places it in the group (not active).
 */
export const productAddMaterialToAltGroup = authRequired
  .input(addMaterialToAltGroupInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return unwrap(await product.addMaterialToAltGroup(input.altGroupId, input.materialId), {
      overrides: inventoryOverrides,
    });
  });

/**
 * Rename (or clear) an alt group's label.
 */
export const productUpdateAltGroupLabel = authRequired
  .input(updateAltGroupLabelInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return unwrap(await product.updateAltGroupLabel(input.altGroupId, input.label));
  });

/**
 * Set which ProductMaterial is active in an alt group.
 *
 * Operators on the shop floor (display tokens) need this to swap to a
 * pre-approved alternate when stock runs out, so it accepts user OR display
 * principals. Group membership is the only authorization gate beyond that —
 * widening to include displays exposes no extra surface compared to the
 * read-side material list already available to the operator screen.
 */
export const productSetAltGroupActive = userOrDisplayRequired
  .input(setAltGroupActiveInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return unwrap(await product.setAltGroupActive(input.altGroupId, input.productMaterialId));
  });

/**
 * Detach a ProductMaterial from its alt group (revert to standalone).
 *
 * If the PM is the group's active and the group has other members, the caller
 * must supply `replaceActiveWithProductMaterialId` — otherwise the server
 * returns `NEEDS_ACTIVE_SWAP` (HTTP 409). Last-member removal deletes the group.
 */
export const productRemoveFromAltGroup = authRequired
  .input(removeFromAltGroupInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return unwrap(await product.removeFromAltGroup(input.productMaterialId, input.replaceActiveWithProductMaterialId));
  });

/**
 * Delete an alt group: all members revert to standalone, then the group row
 * is removed.
 */
export const productDeleteAltGroup = authRequired.input(altGroupIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return unwrap(await product.deleteAltGroup(input.altGroupId));
});

// ============================================================================
// Input Schemas - Material Ledger
// ============================================================================

const materialLedgerKindSchema = z.enum([
  "RECEIPT",
  "ADJUSTMENT",
  "WRITE_OFF",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "OPENING_BALANCE",
]);

// Accept numbers or numeric strings so high-precision decimals survive JSON.
const decimalInputSchema = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]);

const materialLedgerCreateInputSchema = z.object({
  siteId: z.uuid(),
  materialId: z.uuid(),
  kind: materialLedgerKindSchema,
  quantity: decimalInputSchema,
  unit: weightUnitSchema,
  unitCost: decimalInputSchema.optional(),
  reference: z.string().max(255).optional(),
  note: z.string().max(2000).optional(),
});

const materialLedgerListInputSchema = z.object({
  siteId: z.uuid().optional(),
  materialId: z.uuid().optional(),
  kind: materialLedgerKindSchema.optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

const materialLedgerUsageInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  startDate: dateStringSchema.optional(),
  endDate: dateStringSchema.optional(),
  groupByJob: z.boolean().default(true),
  groupByProduct: z.boolean().default(true),
  jobId: z.uuid().optional(),
  productId: z.uuid().optional(),
  materialId: z.uuid().optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures - Material Ledger
// ============================================================================

export const materialLedgerCreate = authRequired
  .input(materialLedgerCreateInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await materialLedger.create({
      siteId: input.siteId,
      materialId: input.materialId,
      kind: input.kind,
      quantity: input.quantity,
      unit: input.unit,
      unitCost: input.unitCost,
      reference: input.reference,
      note: input.note,
      performedByUserId: "id" in context.iam ? context.iam.id : null,
    });
    // Ledger adjustments validate the material/site pairing as part of the
    // request payload, so SITE_MISMATCH has always been BAD_REQUEST here
    // (unlike the rest of this router, where it is a CONFLICT).
    return unwrap(result, { overrides: { SITE_MISMATCH: "BAD_REQUEST" } });
  });

export const materialLedgerList = authRequired
  .input(materialLedgerListInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return materialLedger.list(input);
  });

export const materialLedgerUsage = authRequired
  .input(materialLedgerUsageInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }
    return materialLedger.usage(input);
  });
