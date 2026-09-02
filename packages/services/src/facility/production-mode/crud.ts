import prisma, { Prisma } from "@rw/db";
import { validateSiteRoleIds } from "../../employee/actor-role.js";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";
import { validateDispositionReasonPair } from "../../inventory/disposition-log.js";

const modeInclude = {
  roles: { select: { id: true, name: true }, orderBy: { name: "asc" } },
  itemDisposition: { select: { id: true, name: true } },
  dispositionReason: { select: { id: true, name: true } },
  statusReason: { select: { id: true, name: true } },
} as const;

type ProductionModeRecord = Prisma.ProductionModeGetPayload<{ include: typeof modeInclude }>;
type ServiceError = { error: string; code: string };

const DUPLICATE_NAME: ServiceError = {
  error: "A production mode with this name already exists for this site",
  code: "DUPLICATE_NAME",
};

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export interface CreateProductionModeInput {
  siteId: string;
  name: string;
  description?: string;
  scrapAll?: boolean;
  /** Required when scrapAll; the disposition is always the site's "Scrap". */
  dispositionReasonId?: string | null;
  /** Downtime beginning under this mode defaults to this reason. */
  statusReasonId?: string | null;
  /** Roles allowed to enter/exit the mode; empty/omitted = everyone. */
  roleIds?: string[];
}

export interface UpdateProductionModeInput {
  name?: string;
  description?: string | null;
  scrapAll?: boolean;
  dispositionReasonId?: string | null;
  statusReasonId?: string | null;
  /** Replaces the whole list; [] clears the restriction. */
  roleIds?: string[];
}

export interface ListProductionModesFilter {
  siteId?: string;
  includeArchived?: boolean;
  name?: string;
  limit?: number;
  offset?: number;
}

/** The default downtime reason must be a live status reason of the mode's site. */
async function validateStatusReasonId(siteId: string, statusReasonId: string | null): Promise<ServiceError | null> {
  if (!statusReasonId) return null;
  const reason = await prisma.statusReason.findUnique({
    where: { id: statusReasonId },
    select: { siteId: true, archivedAt: true },
  });
  if (!reason || reason.archivedAt || reason.siteId !== siteId) {
    return { error: "Status reason not found", code: "STATUS_REASON_NOT_FOUND" };
  }
  return null;
}

/**
 * A scrap-all mode always dispositions as the site's "Scrap" disposition —
 * only the reason is chosen. scrapAll off clears the pair.
 */
async function resolveScrapConfig(
  siteId: string,
  scrapAll: boolean,
  dispositionReasonId: string | null,
): Promise<ServiceError | { itemDispositionId: string | null; dispositionReasonId: string | null }> {
  if (!scrapAll) return { itemDispositionId: null, dispositionReasonId: null };

  const scrap = await prisma.itemDisposition.findFirst({
    where: { siteId, isSystem: true, deletedAt: null },
    select: { id: true },
  });
  if (!scrap) {
    return { error: "No system Scrap disposition exists for this site", code: "SCRAP_DISPOSITION_NOT_FOUND" };
  }
  if (!dispositionReasonId) {
    return { error: "A scrap reason is required for a scrap-all mode", code: "SCRAP_REASON_REQUIRED" };
  }
  const pair = await validateDispositionReasonPair(siteId, scrap.id, dispositionReasonId);
  if ("error" in pair) return pair;
  return { itemDispositionId: scrap.id, dispositionReasonId };
}

export async function create(input: CreateProductionModeInput): Promise<ServiceError | { data: ProductionModeRecord }> {
  const { siteId, name, description, scrapAll = false, roleIds = [] } = input;

  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true, workspaceId: true } });
  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const roleError = await validateSiteRoleIds(siteId, roleIds);
  if (roleError) return roleError;

  const scrap = await resolveScrapConfig(siteId, scrapAll, input.dispositionReasonId ?? null);
  if ("error" in scrap) return scrap;

  const reasonError = await validateStatusReasonId(siteId, input.statusReasonId ?? null);
  if (reasonError) return reasonError;

  try {
    const mode = await prisma.productionMode.create({
      data: {
        siteId,
        name,
        description: description ?? null,
        scrapAll,
        itemDispositionId: scrap.itemDispositionId,
        dispositionReasonId: scrap.dispositionReasonId,
        statusReasonId: input.statusReasonId ?? null,
        roles: { connect: roleIds.map((id) => ({ id })) },
      },
      include: modeInclude,
    });

    publishEntityEvent({
      action: "created",
      entityKey: SYSTEM_ENTITY_KEYS.ProductionMode,
      entityId: mode.id,
      siteId: mode.siteId,
      workspaceId: site.workspaceId,
    });

    return { data: mode };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

export async function list(filter: ListProductionModesFilter = {}) {
  const { siteId, includeArchived, name, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = {};
  if (!includeArchived) where.archivedAt = null;
  if (siteId) where.siteId = siteId;
  if (name) where.name = { contains: name, mode: "insensitive" };

  const [modes, total] = await Promise.all([
    prisma.productionMode.findMany({
      where,
      include: modeInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.productionMode.count({ where }),
  ]);

  return { data: modes, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string) {
  const mode = await prisma.productionMode.findUnique({ where: { id }, include: modeInclude });
  if (!mode || mode.archivedAt) {
    return null;
  }
  return { data: mode };
}

export async function update(
  id: string,
  input: UpdateProductionModeInput,
): Promise<ServiceError | { data: ProductionModeRecord }> {
  const current = await prisma.productionMode.findUnique({
    where: { id },
    select: {
      id: true,
      siteId: true,
      archivedAt: true,
      scrapAll: true,
      itemDispositionId: true,
      dispositionReasonId: true,
      site: { select: { workspaceId: true } },
    },
  });
  if (!current || current.archivedAt) {
    return { error: "Production mode not found", code: "MODE_NOT_FOUND" };
  }

  const roleError = await validateSiteRoleIds(current.siteId, input.roleIds ?? []);
  if (roleError) return roleError;

  const updateData: Record<string, unknown> = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.scrapAll !== undefined) updateData.scrapAll = input.scrapAll;
  if (input.scrapAll !== undefined || input.dispositionReasonId !== undefined) {
    const scrap = await resolveScrapConfig(
      current.siteId,
      input.scrapAll ?? current.scrapAll,
      input.dispositionReasonId !== undefined ? input.dispositionReasonId : current.dispositionReasonId,
    );
    if ("error" in scrap) return scrap;
    updateData.itemDispositionId = scrap.itemDispositionId;
    updateData.dispositionReasonId = scrap.dispositionReasonId;
  }
  if (input.statusReasonId !== undefined) {
    const reasonError = await validateStatusReasonId(current.siteId, input.statusReasonId);
    if (reasonError) return reasonError;
    updateData.statusReasonId = input.statusReasonId;
  }
  if (input.roleIds !== undefined) updateData.roles = { set: input.roleIds.map((id) => ({ id })) };

  try {
    const mode = await prisma.productionMode.update({ where: { id }, data: updateData, include: modeInclude });

    publishEntityEvent({
      action: "updated",
      entityKey: SYSTEM_ENTITY_KEYS.ProductionMode,
      entityId: mode.id,
      siteId: mode.siteId,
      workspaceId: current.site.workspaceId,
      changedFields: Object.keys(updateData),
    });

    return { data: mode };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

/** Archive (soft): stations still in the mode stay in it until cleared. */
export async function archive(id: string): Promise<ServiceError | { data: { success: boolean } }> {
  const mode = await prisma.productionMode.findUnique({
    where: { id },
    select: { id: true, siteId: true, archivedAt: true, site: { select: { workspaceId: true } } },
  });
  if (!mode || mode.archivedAt) {
    return { error: "Production mode not found", code: "MODE_NOT_FOUND" };
  }

  await prisma.productionMode.update({ where: { id }, data: { archivedAt: new Date() } });

  publishEntityEvent({
    action: "deleted",
    entityKey: SYSTEM_ENTITY_KEYS.ProductionMode,
    entityId: mode.id,
    siteId: mode.siteId,
    workspaceId: mode.site.workspaceId,
  });

  return { data: { success: true } };
}
