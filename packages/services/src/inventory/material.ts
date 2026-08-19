import prisma from "@rw/db";
import { Prisma, type WeightUnit } from "@rw/db";
import { publishEntityEvent } from "../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../entity/registry.js";

// ============================================================================
// Types
// ============================================================================

export interface CreateMaterialInput {
  siteId: string;
  materialNumber: string;
  name?: string;
  shortCode?: string;
  description?: string;
  externalNumber?: string;
  weightUnits?: WeightUnit | null;
  unitCost?: number | string | null;
  attrs?: Record<string, unknown>;
}

export interface UpdateMaterialInput {
  materialNumber?: string;
  name?: string;
  shortCode?: string;
  description?: string;
  externalNumber?: string;
  weightUnits?: WeightUnit | null;
  unitCost?: number | string | null;
  attrs?: Record<string, unknown>;
}

export interface ListMaterialsFilter {
  siteId?: string;
  /** Free-text search across materialNumber, name, shortCode, description (case-insensitive contains, OR) */
  q?: string;
  name?: string;
  materialNumber?: string;
  shortCode?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Create a new material with initial version (version 1)
 */
export async function create(input: CreateMaterialInput) {
  const { siteId, materialNumber, name, shortCode, description, externalNumber, weightUnits, unitCost, attrs } = input;

  // Verify site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Create material and initial version in transaction
  const material = await prisma.$transaction(async (tx) => {
    // 1. Create Material entity
    const mat = await tx.material.create({
      data: { siteId },
    });

    // 2. Create initial MaterialVersion (version 1)
    const version = await tx.materialVersion.create({
      data: {
        materialId: mat.id,
        version: 1,
        materialNumber,
        name: name ?? null,
        shortCode: shortCode ?? null,
        description: description ?? null,
        externalNumber: externalNumber ?? null,
        weightUnits: weightUnits ?? null,
        unitCost: unitCost != null ? new Prisma.Decimal(unitCost) : null,
        attrs: attrs ?? {},
      },
    });

    // 3. Link version as current and return
    return tx.material.update({
      where: { id: mat.id },
      data: { currentVersionId: version.id },
      include: {
        currentVersion: true,
        site: { select: { id: true, name: true } },
        _count: { select: { products: true, versions: true } },
      },
    });
  });

  publishEntityEvent({
    action: "created",
    entityKey: SYSTEM_ENTITY_KEYS.Material,
    entityId: material.id,
    siteId: material.siteId,
    workspaceId: site.workspaceId,
  });

  return { data: material };
}

/**
 * List materials with optional filtering
 */
export async function list(filter: ListMaterialsFilter = {}) {
  const { siteId, q, name, materialNumber, shortCode, limit = 50, offset = 0 } = filter;

  const where: Prisma.MaterialWhereInput = {
    deletedAt: null,
  };

  if (siteId) {
    where.siteId = siteId;
  }

  // Free-text search OR'd across the columns shown in the UI.
  if (q) {
    where.currentVersion = {
      OR: [
        { materialNumber: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { shortCode: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ],
    };
  } else if (name || materialNumber || shortCode) {
    // Legacy field-specific filters (AND).
    where.currentVersion = {};
    if (name) {
      where.currentVersion.name = { contains: name, mode: "insensitive" };
    }
    if (materialNumber) {
      where.currentVersion.materialNumber = { contains: materialNumber, mode: "insensitive" };
    }
    if (shortCode) {
      where.currentVersion.shortCode = { contains: shortCode, mode: "insensitive" };
    }
  }

  const [materials, total] = await Promise.all([
    prisma.material.findMany({
      where,
      include: {
        currentVersion: true,
        site: { select: { id: true, name: true } },
        _count: { select: { products: true, versions: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.material.count({ where }),
  ]);

  return {
    data: materials,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get material by ID with current version
 */
export async function getById(id: string) {
  const material = await prisma.material.findUnique({
    where: { id },
    include: {
      currentVersion: true,
      site: { select: { id: true, name: true } },
      products: {
        include: {
          product: {
            include: {
              currentVersion: true,
            },
          },
        },
      },
      _count: { select: { products: true, versions: true } },
    },
  });

  if (!material) {
    return null;
  }

  if (material.deletedAt) {
    return { error: "Material has been deleted", code: "MATERIAL_DELETED" };
  }

  return { data: material };
}

/**
 * Update material (creates new version version)
 */
export async function update(id: string, input: UpdateMaterialInput) {
  const { materialNumber, name, shortCode, description, externalNumber, weightUnits, unitCost, attrs } = input;

  // Get current material with version
  const current = await prisma.material.findUnique({
    where: { id },
    include: { currentVersion: true, site: { select: { workspaceId: true } } },
  });

  if (!current) {
    return { error: "Material not found", code: "MATERIAL_NOT_FOUND" };
  }

  if (current.deletedAt) {
    return { error: "Material has been deleted", code: "MATERIAL_DELETED" };
  }

  if (!current.currentVersion) {
    return { error: "Material has no current version", code: "NO_CURRENT_VERSION" };
  }

  const currentVersion = current.currentVersion;

  // Get next version number
  const latestVersion = await prisma.materialVersion.findFirst({
    where: { materialId: id },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const nextVersion = (latestVersion?.version ?? 0) + 1;

  // Create new version with merged data
  const material = await prisma.$transaction(async (tx) => {
    const version = await tx.materialVersion.create({
      data: {
        materialId: id,
        version: nextVersion,
        materialNumber: materialNumber ?? currentVersion.materialNumber,
        name: name !== undefined ? name : currentVersion.name,
        shortCode: shortCode !== undefined ? shortCode : currentVersion.shortCode,
        description: description !== undefined ? description : currentVersion.description,
        externalNumber: externalNumber !== undefined ? externalNumber : currentVersion.externalNumber,
        weightUnits: weightUnits !== undefined ? weightUnits : currentVersion.weightUnits,
        unitCost:
          unitCost !== undefined ? (unitCost != null ? new Prisma.Decimal(unitCost) : null) : currentVersion.unitCost,
        attrs: attrs !== undefined ? attrs : (currentVersion.attrs as Record<string, unknown>),
      },
    });

    return tx.material.update({
      where: { id },
      data: { currentVersionId: version.id },
      include: {
        currentVersion: true,
        site: { select: { id: true, name: true } },
        _count: { select: { products: true, versions: true } },
      },
    });
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Material,
    entityId: material.id,
    siteId: material.siteId,
    workspaceId: current.site.workspaceId,
    changedFields: Object.entries({ materialNumber, name, shortCode, description, externalNumber, weightUnits })
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  });

  return { data: material };
}

/**
 * Soft delete material (sets deletedAt)
 */
export async function remove(id: string) {
  const material = await prisma.material.findUnique({
    where: { id },
    include: {
      site: { select: { workspaceId: true } },
      _count: { select: { products: true } },
    },
  });

  if (!material) {
    return { error: "Material not found", code: "MATERIAL_NOT_FOUND" };
  }

  if (material.deletedAt) {
    return { error: "Material already deleted", code: "MATERIAL_DELETED" };
  }

  if (material._count.products > 0) {
    return {
      error: "Cannot delete material that is linked to products. Remove from products first.",
      code: "HAS_PRODUCTS",
    };
  }

  await prisma.material.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  publishEntityEvent({
    action: "deleted",
    entityKey: SYSTEM_ENTITY_KEYS.Material,
    entityId: material.id,
    siteId: material.siteId,
    workspaceId: material.site.workspaceId,
  });

  return { success: true };
}

/**
 * Check if material exists
 */
export async function exists(id: string) {
  const material = await prisma.material.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  return material !== null && material.deletedAt === null;
}

/**
 * Get material version history (all versions)
 */
export async function getVersionHistory(id: string) {
  const material = await prisma.material.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, currentVersionId: true },
  });

  if (!material) {
    return { error: "Material not found", code: "MATERIAL_NOT_FOUND" };
  }

  const versions = await prisma.materialVersion.findMany({
    where: { materialId: id },
    orderBy: { version: "desc" },
  });

  return {
    data: versions.map((version) => ({
      ...version,
      isCurrent: version.id === material.currentVersionId,
    })),
  };
}
