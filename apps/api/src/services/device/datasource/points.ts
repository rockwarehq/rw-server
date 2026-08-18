import prisma, { type Prisma } from "@rw/db";
import { validatePointConfig } from "../../validation.js";
import { bumpSpecVersion } from "@rw/services/device/gateway/index";
import { publishEntityEvent } from "@rw/services/entity/index";
import { SYSTEM_ENTITY_KEYS } from "@rw/services/entity/registry";

export interface CreatePointInput {
  name: string;
  description?: string;
  sourceType?: "DRIVER" | "STATIC";
  staticValue?: unknown;
  address?: string;
  dataType?: string;
  scaleFactor?: number;
  offset?: number;
  config?: Record<string, unknown>;
  groupId?: string | null;
}

export interface UpdatePointInput {
  name?: string;
  description?: string;
  staticValue?: unknown;
  address?: string;
  dataType?: string;
  scaleFactor?: number;
  offset?: number;
  config?: Record<string, unknown>;
  groupId?: string | null;
}

// Static point changes reach livestore's entity resolver via entity.changes; siteless datasources have no graph scope, so skip.
function publishPointEntityEvent(args: {
  action: "created" | "updated" | "deleted";
  pointId: string;
  siteId: string | null;
  workspaceId: string | undefined;
  changedFields?: string[];
}): void {
  if (!args.siteId || !args.workspaceId) return;
  publishEntityEvent({
    action: args.action,
    entityKey: SYSTEM_ENTITY_KEYS.Point,
    entityId: args.pointId,
    siteId: args.siteId,
    workspaceId: args.workspaceId,
    changedFields: args.changedFields,
  });
}

export interface ListPointsFilter {
  datasourceId?: string;
  groupId?: string;
  ungrouped?: boolean;
}

/**
 * Create a point for a datasource
 */
export async function create(datasourceId: string, input: CreatePointInput) {
  const { name, description, sourceType, staticValue, address, dataType, scaleFactor, offset, config } = input;
  const rawGroupId = input.groupId;
  const isStatic = sourceType === "STATIC";

  // Convert empty string to null
  const groupId = rawGroupId === "" ? null : rawGroupId;

  const datasource = await prisma.datasource.findUnique({
    where: { id: datasourceId },
    include: { site: { select: { workspaceId: true } } },
  });
  if (!datasource) {
    return { error: "Datasource not found", code: "DATASOURCE_NOT_FOUND" };
  }

  if (isStatic && staticValue === undefined) {
    return { error: "Static point requires staticValue", code: "VALIDATION_FAILED" };
  }
  if (!isStatic && (address === undefined || dataType === undefined)) {
    return { error: "Driver point requires address and dataType", code: "VALIDATION_FAILED" };
  }

  // Verify group exists and belongs to same datasource if provided
  if (groupId) {
    const group = await prisma.pointGroup.findUnique({ where: { id: groupId } });
    if (!group) {
      return { error: "Point group not found", code: "GROUP_NOT_FOUND" };
    }
    if (group.datasourceId !== datasourceId) {
      return { error: "Point group belongs to different datasource", code: "GROUP_MISMATCH" };
    }
  }

  // Validate config against driver's pointSchema (if config provided); static points aren't driver-bound
  if (!isStatic && config && Object.keys(config).length > 0) {
    const requiredConfig = { address, dataType, ...config };
    const validation = validatePointConfig(datasource.driver, requiredConfig, datasource.driverVersion);
    if (!validation.valid) {
      return {
        error: "Point config validation failed",
        code: "VALIDATION_FAILED",
        details: validation.errors,
      };
    }
  }

  const point = await prisma.point.create({
    data: {
      name,
      description,
      sourceType: isStatic ? "STATIC" : "DRIVER",
      staticValue: isStatic ? (staticValue as Prisma.InputJsonValue) : undefined,
      address: address ?? "",
      dataType: dataType ?? "",
      scaleFactor: scaleFactor ?? 1.0,
      offset: offset ?? 0.0,
      config: config || {},
      datasourceId,
      groupId,
    },
  });

  // Static points never reach gateways, so no spec bump
  if (isStatic) {
    publishPointEntityEvent({
      action: "created",
      pointId: point.id,
      siteId: datasource.siteId,
      workspaceId: datasource.site?.workspaceId,
    });
  } else if (datasource.gatewayId) {
    await bumpSpecVersion(datasource.gatewayId);
  }

  return { data: point };
}

/**
 * List points for a datasource with optional filtering
 */
export async function list(datasourceId: string, filter: Omit<ListPointsFilter, "datasourceId"> = {}) {
  const { groupId, ungrouped } = filter;

  const datasource = await prisma.datasource.findUnique({ where: { id: datasourceId } });
  if (!datasource) {
    return { error: "Datasource not found", code: "DATASOURCE_NOT_FOUND" };
  }

  const where: Record<string, unknown> = { datasourceId };
  if (groupId) {
    where.groupId = groupId;
  } else if (ungrouped) {
    where.groupId = null;
  }

  const points = await prisma.point.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });

  return { data: points };
}

/**
 * Get point by ID
 */
export async function getById(id: string) {
  return prisma.point.findUnique({
    where: { id },
    include: {
      datasource: {
        select: { id: true, name: true, driver: true, gatewayId: true },
      },
      group: {
        select: { id: true, name: true },
      },
    },
  });
}

/**
 * Update point
 */
export async function update(id: string, input: UpdatePointInput) {
  const { name, description, staticValue, address, dataType, scaleFactor, offset, config } = input;
  const rawGroupId = input.groupId;

  // Convert empty string to null
  const groupId = rawGroupId === "" ? null : rawGroupId;

  const existing = await prisma.point.findUnique({
    where: { id },
    include: {
      datasource: {
        select: {
          id: true,
          driver: true,
          driverVersion: true,
          gatewayId: true,
          siteId: true,
          site: { select: { workspaceId: true } },
        },
      },
    },
  });

  if (!existing) {
    return { error: "Point not found", code: "NOT_FOUND" };
  }

  // Verify group exists and belongs to same datasource if provided
  if (groupId) {
    const group = await prisma.pointGroup.findUnique({ where: { id: groupId } });
    if (!group) {
      return { error: "Point group not found", code: "GROUP_NOT_FOUND" };
    }
    if (group.datasourceId !== existing.datasourceId) {
      return { error: "Point group belongs to different datasource", code: "GROUP_MISMATCH" };
    }
  }

  const isStatic = existing.sourceType === "STATIC";

  // Validate config against driver's pointSchema (if config provided); static points aren't driver-bound
  if (!isStatic && config && Object.keys(config).length > 0) {
    const requiredConfig = { address, dataType, ...config };
    const validation = validatePointConfig(
      existing.datasource.driver,
      requiredConfig,
      existing.datasource.driverVersion,
    );
    if (!validation.valid) {
      return {
        error: "Point config validation failed",
        code: "VALIDATION_FAILED",
        details: validation.errors,
      };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (isStatic && staticValue !== undefined) updateData.staticValue = staticValue;
  if (address !== undefined) updateData.address = address;
  if (dataType !== undefined) updateData.dataType = dataType;
  if (scaleFactor !== undefined) updateData.scaleFactor = scaleFactor;
  if (offset !== undefined) updateData.offset = offset;
  if (config !== undefined) updateData.config = config;
  if (groupId !== undefined) updateData.groupId = groupId;

  const point = await prisma.point.update({
    where: { id },
    data: updateData as Prisma.PointUpdateInput,
  });

  if (isStatic) {
    // Emit only fields that really changed so livestore skips no-op refreshes
    const changedFields = [
      name !== undefined && name !== existing.name ? "name" : null,
      description !== undefined && description !== existing.description ? "description" : null,
      staticValue !== undefined && JSON.stringify(staticValue) !== JSON.stringify(existing.staticValue)
        ? "staticValue"
        : null,
    ].filter((f): f is string => f !== null);
    if (changedFields.length > 0) {
      publishPointEntityEvent({
        action: "updated",
        pointId: point.id,
        siteId: existing.datasource.siteId,
        workspaceId: existing.datasource.site?.workspaceId,
        changedFields,
      });
    }
  } else if (existing.datasource.gatewayId) {
    await bumpSpecVersion(existing.datasource.gatewayId);
  }

  return { data: point };
}

/**
 * Delete point
 */
export async function remove(id: string) {
  const existing = await prisma.point.findUnique({
    where: { id },
    include: {
      datasource: {
        select: { gatewayId: true, siteId: true, site: { select: { workspaceId: true } } },
      },
    },
  });

  if (!existing) {
    return { error: "Point not found", code: "NOT_FOUND" };
  }

  await prisma.point.delete({ where: { id } });

  if (existing.sourceType === "STATIC") {
    publishPointEntityEvent({
      action: "deleted",
      pointId: id,
      siteId: existing.datasource.siteId,
      workspaceId: existing.datasource.site?.workspaceId,
    });
  } else if (existing.datasource.gatewayId) {
    await bumpSpecVersion(existing.datasource.gatewayId);
  }

  return { success: true };
}

/**
 * Bulk create points for a datasource
 */
export async function bulkCreate(datasourceId: string, pointsInput: CreatePointInput[]) {
  const datasource = await prisma.datasource.findUnique({ where: { id: datasourceId } });
  if (!datasource) {
    return { error: "Datasource not found", code: "DATASOURCE_NOT_FOUND" };
  }

  // Convert empty string groupIds to null
  const pointsData = pointsInput.map((p) => ({
    ...p,
    groupId: p.groupId === "" ? null : p.groupId,
  }));

  // Validate all point configs before creating any; bulk import is driver-only
  for (let i = 0; i < pointsData.length; i++) {
    const p = pointsData[i];
    if (p.sourceType === "STATIC") {
      return {
        error: `Static points cannot be bulk created (point at index ${i}, "${p.name}")`,
        code: "VALIDATION_FAILED",
      };
    }
    if (p.address === undefined || p.dataType === undefined) {
      return {
        error: `Driver point requires address and dataType (point at index ${i}, "${p.name}")`,
        code: "VALIDATION_FAILED",
      };
    }
    if (p.config && Object.keys(p.config).length > 0) {
      const validation = validatePointConfig(datasource.driver, p.config, datasource.driverVersion);
      if (!validation.valid) {
        return {
          error: `Point config validation failed for point at index ${i} ("${p.name}")`,
          code: "VALIDATION_FAILED",
          details: validation.errors,
        };
      }
    }
  }

  // Create all points in a transaction
  const createdPoints = await prisma.$transaction(
    pointsData.map((p) =>
      prisma.point.create({
        data: {
          name: p.name,
          description: p.description,
          address: p.address ?? "",
          dataType: p.dataType ?? "",
          scaleFactor: p.scaleFactor ?? 1.0,
          offset: p.offset ?? 0.0,
          config: p.config || {},
          datasourceId,
          groupId: p.groupId,
        },
      }),
    ),
  );

  // Update gateway spec once after all points created
  if (datasource.gatewayId) {
    await bumpSpecVersion(datasource.gatewayId);
  }

  return {
    data: {
      created: createdPoints.length,
      points: createdPoints,
    },
  };
}

/**
 * Check if point exists
 */
export async function exists(id: string) {
  const point = await prisma.point.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!point;
}
