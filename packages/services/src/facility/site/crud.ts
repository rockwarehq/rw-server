import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { auditRecord } from "../../audit/index.js";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";
import { seedDefaults as seedDefaultRoles } from "../../employee/role.js";
import { forgetSiteTimezone } from "../../metrics/bucket.js";
import { rematerializeSite, sameWallClockInstant } from "../shift/materialize.js";

const AUDIT_FIELDS = ["name", "description", "timezone", "weekStart"] as const;

/** A site's fields with each attrs key as its own `attrs.<key>` field, so a change names the setting. */
function auditValues(site: {
  name: string;
  description: string | null;
  timezone: string;
  weekStart: string;
  attrs: unknown;
}) {
  const attrs = (site.attrs ?? {}) as Record<string, unknown>;
  return {
    name: site.name,
    description: site.description,
    timezone: site.timezone,
    weekStart: site.weekStart,
    ...Object.fromEntries(Object.entries(attrs).map(([key, value]) => [`attrs.${key}`, value])),
  } as Record<string, unknown>;
}

function auditFields(...values: Record<string, unknown>[]) {
  const attrKeys = new Set(values.flatMap((each) => Object.keys(each).filter((key) => key.startsWith("attrs."))));
  return [...AUDIT_FIELDS, ...attrKeys];
}

export interface CreateSiteInput {
  name: string;
  description?: string;
  attrs?: Record<string, unknown>;
  workspaceId: string;
}

export interface UpdateSiteInput {
  name?: string;
  description?: string;
  timezone?: string;
  weekStart?: "SUNDAY" | "MONDAY";
  attrs?: Record<string, unknown>;
}

export interface ListSitesFilter {
  workspaceId?: string;
  siteIds?: string[];
  name?: string;
  limit?: number;
  offset?: number;
}

/**
 * Create a new site
 */
export async function create(input: CreateSiteInput) {
  const { name, description, attrs, workspaceId } = input;

  const site = await prisma.$transaction(async (tx) => {
    const created = await tx.site.create({
      data: {
        name,
        description,
        attrs: attrs ?? {},
        workspaceId,
        // The plant's access container is born with the plant.
        buckets: { create: { workspaceId, kind: "PLANT", name } },
      },
      include: {
        _count: {
          select: { workcenters: true, gateways: true, datasources: true },
        },
      },
    });
    const after = auditValues(created);
    await auditRecord(tx, {
      change: "created",
      entityType: "site",
      entityId: created.id,
      siteId: created.id,
      workspaceId,
      label: created.name,
      after,
      fields: auditFields(after),
    });
    return created;
  });

  // Seed default employee roles for the new site
  await seedDefaultRoles(site.id);

  publishEntityEvent({
    action: "created",
    entityKey: SYSTEM_ENTITY_KEYS.Site,
    entityId: site.id,
    siteId: site.id,
    workspaceId,
  });

  return { data: site };
}

/**
 * List sites with optional filtering
 */
export async function list(filter: ListSitesFilter = {}) {
  const { workspaceId, siteIds, name, limit = 50, offset = 0 } = filter;

  if (siteIds && siteIds.length === 0) {
    return { data: [], total: 0, limit: Number(limit), offset: Number(offset) };
  }

  const where: Record<string, unknown> = {};

  if (workspaceId) {
    where.workspaceId = workspaceId;
  }

  if (siteIds) {
    where.id = { in: siteIds };
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [sites, total] = await Promise.all([
    prisma.site.findMany({
      where,
      include: {
        _count: {
          select: { workcenters: true, gateways: true, datasources: true },
        },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.site.count({ where }),
  ]);

  return {
    data: sites,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get site by ID with related entities
 */
export async function getById(id: string) {
  const site = await prisma.site.findUnique({
    where: { id },
    include: {
      workcenters: {
        where: { parentId: null }, // Only top-level workcenters
        select: {
          id: true,
          name: true,
          description: true,
          _count: { select: { children: true, stations: true } },
        },
        orderBy: { name: "asc" },
      },
      gateways: {
        select: {
          id: true,
          name: true,
          serialNumber: true,
          status: true,
        },
        orderBy: { name: "asc" },
      },
      datasources: {
        select: {
          id: true,
          name: true,
          type: true,
          driver: true,
        },
        orderBy: { name: "asc" },
      },
      _count: {
        select: { workcenters: true, gateways: true, datasources: true },
      },
    },
  });

  if (!site) {
    return null;
  }

  return { data: site };
}

/**
 * Update site
 */
export async function update(id: string, input: UpdateSiteInput) {
  const { name, description, timezone, weekStart, attrs } = input;

  // Get current site
  const current = await prisma.site.findUnique({
    where: { id },
    select: { id: true, name: true, description: true, attrs: true, timezone: true, weekStart: true },
  });

  if (!current) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Forms send the whole payload: only a different zone moves the schedule.
  const movesTimezone = timezone !== undefined && timezone !== current.timezone;

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (movesTimezone) updateData.timezone = timezone;
  if (weekStart !== undefined) updateData.weekStart = weekStart;
  if (attrs !== undefined) {
    // Shallow-merge instead of replace: attrs is shared by unrelated features
    // (logo, order settings), so a caller must not clobber keys it didn't
    // send. Sending `null` for a key deletes it.
    const merged = { ...((current.attrs ?? {}) as Record<string, unknown>), ...attrs };
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null) delete merged[key];
    }
    updateData.attrs = merged;
  }

  const site = await prisma.$transaction(async (tx) => {
    if (movesTimezone) await keepOverrideClockTimes(tx, id, current.timezone, timezone);
    const updated = await tx.site.update({
      where: { id },
      data: {
        ...updateData,
        // The plant bucket carries the site's name.
        ...(name !== undefined ? { buckets: { updateMany: { where: { kind: "PLANT" }, data: { name } } } } : {}),
      },
      include: {
        _count: {
          select: { workcenters: true, gateways: true, datasources: true },
        },
      },
    });
    const before = auditValues(current);
    const after = auditValues(updated);
    await auditRecord(tx, {
      change: "updated",
      entityType: "site",
      entityId: updated.id,
      siteId: updated.id,
      workspaceId: updated.workspaceId,
      label: updated.name,
      before,
      after,
      fields: auditFields(before, after),
    });
    return updated;
  });

  // A timezone change is a schedule edit (ADR-0015): upcoming shifts keep
  // their local clock times in the new zone. The cached zone goes first, or
  // the rebuild would read the old one back.
  if (movesTimezone) {
    forgetSiteTimezone(id);
    await rematerializeSite(id);
  }

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Site,
    entityId: site.id,
    siteId: site.id,
    workspaceId: site.workspaceId,
    changedFields: Object.keys(updateData),
  });

  return { data: site };
}

/**
 * Delete site (fails if has workcenters, gateways, or datasources)
 */
export async function remove(id: string) {
  const site = await prisma.site.findUnique({
    where: { id },
    include: {
      _count: { select: { workcenters: true, gateways: true, datasources: true } },
    },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  if (site._count.workcenters > 0) {
    return {
      error: "Cannot delete site with workcenters. Delete workcenters first.",
      code: "HAS_WORKCENTERS",
    };
  }

  if (site._count.gateways > 0) {
    return {
      error: "Cannot delete site with gateways. Move or delete gateways first.",
      code: "HAS_GATEWAYS",
    };
  }

  if (site._count.datasources > 0) {
    return {
      error: "Cannot delete site with datasources. Move or delete datasources first.",
      code: "HAS_DATASOURCES",
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.site.delete({ where: { id } });
    await auditRecord(tx, {
      change: "deleted",
      entityType: "site",
      entityId: site.id,
      siteId: site.id,
      workspaceId: site.workspaceId,
      label: site.name,
      fields: [],
    });
  });

  publishEntityEvent({
    action: "deleted",
    entityKey: SYSTEM_ENTITY_KEYS.Site,
    entityId: site.id,
    siteId: site.id,
    workspaceId: site.workspaceId,
  });

  return { success: true };
}

/**
 * Build workcenter tree for a site (internal helper)
 */
async function buildSiteWorkcenterTree(siteId: string) {
  // Get all workcenters for this site
  const workcenters = await prisma.workcenter.findMany({
    where: { siteId },
    select: {
      id: true,
      name: true,
      description: true,
      attrs: true,
      parentId: true,
      stations: {
        select: {
          id: true,
          name: true,
          description: true,
          attrs: true,
        },
        orderBy: { name: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  // Build nested workcenter hierarchy
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workcenterMap = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rootWorkcenters: any[] = [];

  // First pass: create map entries
  for (const wc of workcenters) {
    workcenterMap.set(wc.id, {
      id: wc.id,
      name: wc.name,
      description: wc.description,
      attrs: wc.attrs,
      children: [],
      stations: wc.stations,
    });
  }

  // Second pass: build hierarchy
  for (const wc of workcenters) {
    const node = workcenterMap.get(wc.id);
    if (wc.parentId) {
      const parent = workcenterMap.get(wc.parentId);
      if (parent) {
        parent.children.push(node);
      }
    } else {
      rootWorkcenters.push(node);
    }
  }

  return rootWorkcenters;
}

/**
 * Get tree for a single site (Site -> Workcenter -> Station)
 */
export async function getSiteTree(siteId: string) {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      name: true,
      description: true,
      attrs: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const workcenters = await buildSiteWorkcenterTree(siteId);

  // Get ungrouped stations (directly under site, no workcenter)
  const stations = await prisma.station.findMany({
    where: { siteId, workcenterId: null },
    select: {
      id: true,
      name: true,
      description: true,
      attrs: true,
    },
  });

  return {
    data: {
      id: site.id,
      name: site.name,
      description: site.description,
      attrs: site.attrs,
      createdAt: site.createdAt,
      updatedAt: site.updatedAt,
      stations,
      workcenters,
    },
  };
}

/**
 * Get full tree for a workspace (Site -> Workcenter -> Station)
 */
export async function getTree(workspaceId: string, siteIds?: string[]) {
  if (siteIds && siteIds.length === 0) {
    return [];
  }

  // Get all sites for the workspace
  const sites = await prisma.site.findMany({
    where: { workspaceId, ...(siteIds ? { id: { in: siteIds } } : {}) },
    select: {
      id: true,
      name: true,
      description: true,
      attrs: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { name: "asc" },
  });

  // Build tree for each site
  const result = [];

  for (const site of sites) {
    const workcenters = await buildSiteWorkcenterTree(site.id);

    // Get ungrouped stations (directly under site, no workcenter)
    const stations = await prisma.station.findMany({
      where: { siteId: site.id, workcenterId: null },
      select: {
        id: true,
        name: true,
        description: true,
        attrs: true,
      },
    });

    result.push({
      ...site,
      stations,
      workcenters,
    });
  }

  return result;
}

/**
 * Get device tree for a site (Gateway -> Datasources)
 * Returns all gateways with their assigned datasources (all statuses)
 */
export async function getDeviceTree(siteId: string) {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Get all gateways for this site with their datasources
  const gateways = await prisma.gateway.findMany({
    where: { siteId },
    select: {
      id: true,
      name: true,
      serialNumber: true,
      status: true,
      datasources: {
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          driver: true,
          driverVersion: true,
        },
        orderBy: { name: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  return { data: gateways };
}

/**
 * Overrides hold exact instants. Those not started yet move to the same local
 * clock time in the new zone, as definitions do; started ones are history.
 */
async function keepOverrideClockTimes(
  tx: Prisma.TransactionClient,
  siteId: string,
  fromTimezone: string,
  toTimezone: string,
) {
  const upcoming = await tx.shiftOverride.findMany({
    where: { siteId, startTime: { gt: new Date() } },
    select: { id: true, startTime: true, endTime: true },
  });
  for (const o of upcoming) {
    if (!o.startTime || !o.endTime) continue;
    await tx.shiftOverride.update({
      where: { id: o.id },
      data: {
        startTime: new Date(sameWallClockInstant(o.startTime.getTime(), fromTimezone, toTimezone)),
        endTime: new Date(sameWallClockInstant(o.endTime.getTime(), fromTimezone, toTimezone)),
      },
    });
  }
}
