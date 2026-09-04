import prisma from "@rw/db";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";

export interface CreateWorkcenterInput {
  name: string;
  description?: string;
  attrs?: Record<string, unknown>;
  siteId: string;
  parentId?: string;
}

export interface UpdateWorkcenterInput {
  name?: string;
  description?: string;
  attrs?: Record<string, unknown>;
}

export interface ListWorkcentersFilter {
  siteId?: string;
  parentId?: string | null;
  name?: string;
  limit?: number;
  offset?: number;
}

/**
 * Create a new workcenter
 */
export async function create(input: CreateWorkcenterInput) {
  const { name, description, attrs, siteId, parentId } = input;

  // Workcenters are a flat list per site: stations (and later station
  // groups) go under workcenters, never another workcenter. Existing nested
  // rows are tolerated but no new nesting can be created.
  if (parentId) {
    return {
      error: "Workcenters cannot be nested under another workcenter",
      code: "WORKCENTER_NESTING_UNSUPPORTED",
    };
  }

  // Validate site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const workcenter = await prisma.workcenter.create({
    data: {
      name,
      description,
      attrs: attrs ?? {},
      siteId,
    },
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      parent: {
        select: { id: true, name: true },
      },
      _count: {
        select: { children: true, stations: true },
      },
    },
  });

  publishEntityEvent({
    action: "created",
    entityKey: SYSTEM_ENTITY_KEYS.Workcenter,
    entityId: workcenter.id,
    siteId: workcenter.siteId,
    workspaceId: workcenter.site.workspaceId,
  });

  return { data: workcenter };
}

/**
 * List workcenters with optional filtering
 */
export async function list(filter: ListWorkcentersFilter = {}) {
  const { siteId, parentId, name, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = {};

  if (siteId) {
    where.siteId = siteId;
  }

  // Filter by parent (null = top-level workcenters only)
  if (parentId === null) {
    where.parentId = null;
  } else if (parentId) {
    where.parentId = parentId;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [workcenters, total] = await Promise.all([
    prisma.workcenter.findMany({
      where,
      include: {
        site: {
          select: { id: true, name: true, workspaceId: true },
        },
        parent: {
          select: { id: true, name: true },
        },
        _count: {
          select: { children: true, stations: true },
        },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.workcenter.count({ where }),
  ]);

  return {
    data: workcenters,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get workcenter by ID with related entities
 */
export async function getById(id: string, workspaceId?: string) {
  const workcenter = await prisma.workcenter.findUnique({
    where: { id },
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      parent: {
        select: { id: true, name: true },
      },
      children: {
        select: {
          id: true,
          name: true,
          description: true,
          _count: { select: { children: true, stations: true } },
        },
        orderBy: { name: "asc" },
      },
      stations: {
        select: {
          id: true,
          name: true,
          description: true,
        },
        orderBy: { name: "asc" },
      },
      _count: {
        select: { children: true, stations: true },
      },
    },
  });

  if (!workcenter) {
    return null;
  }

  // Validate workspace access
  if (workspaceId && workcenter.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  return { data: workcenter };
}

/**
 * Update workcenter
 */
export async function update(id: string, input: UpdateWorkcenterInput, workspaceId?: string) {
  const { name, description, attrs } = input;

  // Get current workcenter with site info
  const current = await prisma.workcenter.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!current) {
    return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && current.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (attrs !== undefined) updateData.attrs = attrs;

  const workcenter = await prisma.workcenter.update({
    where: { id },
    data: updateData,
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      parent: {
        select: { id: true, name: true },
      },
      _count: {
        select: { children: true, stations: true },
      },
    },
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Workcenter,
    entityId: workcenter.id,
    siteId: workcenter.siteId,
    workspaceId: workcenter.site.workspaceId,
    changedFields: Object.keys(updateData),
  });

  return { data: workcenter };
}

/**
 * Move workcenter to the top level. Nesting is unsupported: the only
 * allowed move is parentId -> null, kept so admins can flatten trees that
 * predate the flat-workcenter rule.
 */
export async function move(id: string, newParentId: string | null, workspaceId?: string) {
  if (newParentId !== null) {
    return {
      error: "Workcenters cannot be nested under another workcenter",
      code: "WORKCENTER_NESTING_UNSUPPORTED",
    };
  }

  const current = await prisma.workcenter.findUnique({
    where: { id },
    include: {
      site: {
        select: { id: true, workspaceId: true },
      },
    },
  });

  if (!current) {
    return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && current.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  const workcenter = await prisma.workcenter.update({
    where: { id },
    data: { parentId: null },
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      parent: {
        select: { id: true, name: true },
      },
      _count: {
        select: { children: true, stations: true },
      },
    },
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Workcenter,
    entityId: workcenter.id,
    siteId: workcenter.siteId,
    workspaceId: workcenter.site.workspaceId,
    changedFields: ["parentId"],
  });

  return { data: workcenter };
}

/**
 * Delete workcenter (fails if has children or stations due to onDelete: Restrict)
 */
export async function remove(id: string, workspaceId?: string) {
  const workcenter = await prisma.workcenter.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
      _count: { select: { children: true, stations: true } },
    },
  });

  if (!workcenter) {
    return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && workcenter.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  if (workcenter._count.children > 0) {
    return {
      error: "Cannot delete workcenter with children. Delete or move children first.",
      code: "HAS_CHILDREN",
    };
  }

  if (workcenter._count.stations > 0) {
    return {
      error: "Cannot delete workcenter with stations. Delete or move stations first.",
      code: "HAS_STATIONS",
    };
  }

  await prisma.workcenter.delete({ where: { id } });

  publishEntityEvent({
    action: "deleted",
    entityKey: SYSTEM_ENTITY_KEYS.Workcenter,
    entityId: workcenter.id,
    siteId: workcenter.siteId,
    workspaceId: workcenter.site.workspaceId,
  });

  return { success: true };
}

/**
 * Check if workcenter exists
 */
export async function exists(id: string) {
  const workcenter = await prisma.workcenter.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!workcenter;
}
