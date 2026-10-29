import prisma from "@rw/db";
import { auditRecord } from "../../audit/index.js";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";

const AUDIT_FIELDS = ["name", "isPlannedDown", "quick", "category", "labels"] as const;

function auditValues(reason: {
  name: string;
  isPlannedDown: boolean;
  quick: boolean;
  category: { name: string } | null;
  labels: { name: string }[];
}) {
  return {
    name: reason.name,
    isPlannedDown: reason.isPlannedDown,
    quick: reason.quick,
    category: reason.category?.name ?? null,
    labels: reason.labels.map((label) => label.name).sort(),
  };
}

export interface CreateStatusReasonInput {
  name: string;
  isPlannedDown?: boolean;
  /** Offered as a one-tap button when coding downtime. */
  quick?: boolean;
  categoryId?: string | null;
  siteId: string;
  /** Labels to put on this code. They must come from the same site's list. */
  labelIds?: string[];
}

export interface UpdateStatusReasonInput {
  name?: string;
  isPlannedDown?: boolean;
  quick?: boolean;
  categoryId?: string | null;
  /** Replaces the code's whole label list with this one (same-site labels only). */
  labelIds?: string[];
}

export interface ListStatusReasonsFilter {
  siteId?: string;
  categoryId?: string;
  /** Only return codes that have at least one of these labels. */
  labelIds?: string[];
  name?: string;
  limit?: number;
  offset?: number;
}

/**
 * Create a new status reason
 */
export async function create(input: CreateStatusReasonInput) {
  const { name, isPlannedDown, quick, categoryId, siteId, labelIds } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Check unique constraint
  const existing = await prisma.statusReason.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { id: true, archivedAt: true },
  });

  if (existing && !existing.archivedAt) {
    return { error: "A status reason with this name already exists for this site", code: "DUPLICATE_NAME" };
  }

  // Validate category if provided
  if (categoryId) {
    const category = await prisma.statusCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!category || category.deletedAt) {
      return { error: "Status category not found", code: "CATEGORY_NOT_FOUND" };
    }

    if (category.siteId !== siteId) {
      return { error: "Status category must belong to the same site", code: "SITE_MISMATCH" };
    }
  }

  if (labelIds && labelIds.length > 0) {
    const found = await prisma.label.count({ where: { id: { in: labelIds }, siteId } });
    if (found !== labelIds.length) {
      return { error: "One or more labels not found for this site", code: "LABEL_NOT_FOUND" };
    }
  }

  const reason = await prisma.$transaction(async (tx) => {
    const created = await tx.statusReason.create({
      data: {
        name,
        isPlannedDown: isPlannedDown ?? false,
        quick: quick ?? false,
        categoryId: categoryId ?? null,
        siteId,
        ...(labelIds?.length ? { labels: { connect: labelIds.map((id) => ({ id })) } } : {}),
      },
      include: {
        category: {
          select: { id: true, name: true },
        },
        labels: { select: { id: true, name: true, color: true } },
      },
    });
    await auditRecord(tx, {
      change: "created",
      entityType: "status-reason",
      entityId: created.id,
      siteId: created.siteId,
      workspaceId: site.workspaceId,
      label: created.name,
      after: auditValues(created),
      fields: AUDIT_FIELDS,
    });
    return created;
  });

  publishEntityEvent({
    action: "created",
    entityKey: SYSTEM_ENTITY_KEYS.StatusReason,
    entityId: reason.id,
    siteId: reason.siteId,
    workspaceId: site.workspaceId,
  });

  return { data: reason };
}

/**
 * List status reasons with optional filtering
 */
export async function list(filter: ListStatusReasonsFilter = {}) {
  const { siteId, categoryId, labelIds, name, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = { archivedAt: null };

  if (siteId) {
    where.siteId = siteId;
  }

  if (categoryId) {
    where.categoryId = categoryId;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  if (labelIds && labelIds.length > 0) {
    where.labels = { some: { id: { in: labelIds } } };
  }

  const [reasons, total] = await Promise.all([
    prisma.statusReason.findMany({
      where,
      include: {
        category: {
          select: { id: true, name: true },
        },
        labels: { select: { id: true, name: true, color: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.statusReason.count({ where }),
  ]);

  return {
    data: reasons,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get status reason by ID
 */
export async function getById(id: string) {
  const reason = await prisma.statusReason.findUnique({
    where: { id },
    include: {
      category: {
        select: { id: true, name: true },
      },
      labels: { select: { id: true, name: true, color: true } },
    },
  });

  if (!reason || reason.archivedAt) {
    return null;
  }

  return { data: reason };
}

/**
 * Update status reason
 */
export async function update(id: string, input: UpdateStatusReasonInput) {
  const { name, isPlannedDown, quick, categoryId, labelIds } = input;

  const current = await prisma.statusReason.findUnique({
    where: { id },
    select: {
      id: true,
      siteId: true,
      name: true,
      isPlannedDown: true,
      quick: true,
      archivedAt: true,
      site: { select: { workspaceId: true } },
      category: { select: { name: true } },
      labels: { select: { name: true } },
    },
  });

  if (!current || current.archivedAt) {
    return { error: "Status reason not found", code: "STATUS_REASON_NOT_FOUND" };
  }

  // Check unique constraint if name is changing
  if (name !== undefined) {
    const existing = await prisma.statusReason.findUnique({
      where: { siteId_name: { siteId: current.siteId, name } },
      select: { id: true, archivedAt: true },
    });

    if (existing && existing.id !== id && !existing.archivedAt) {
      return { error: "A status reason with this name already exists for this site", code: "DUPLICATE_NAME" };
    }
  }

  // Validate category if changing
  if (categoryId !== undefined && categoryId !== null) {
    const category = await prisma.statusCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!category || category.deletedAt) {
      return { error: "Status category not found", code: "CATEGORY_NOT_FOUND" };
    }

    if (category.siteId !== current.siteId) {
      return { error: "Status category must belong to the same site", code: "SITE_MISMATCH" };
    }
  }

  if (labelIds && labelIds.length > 0) {
    const found = await prisma.label.count({ where: { id: { in: labelIds }, siteId: current.siteId } });
    if (found !== labelIds.length) {
      return { error: "One or more labels not found for this site", code: "LABEL_NOT_FOUND" };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (isPlannedDown !== undefined) updateData.isPlannedDown = isPlannedDown;
  if (quick !== undefined) updateData.quick = quick;
  if (categoryId !== undefined) updateData.categoryId = categoryId;
  if (labelIds !== undefined) updateData.labels = { set: labelIds.map((lid) => ({ id: lid })) };

  const reason = await prisma.$transaction(async (tx) => {
    const updated = await tx.statusReason.update({
      where: { id },
      data: updateData,
      include: {
        category: {
          select: { id: true, name: true },
        },
        labels: { select: { id: true, name: true, color: true } },
      },
    });
    await auditRecord(tx, {
      change: "updated",
      entityType: "status-reason",
      entityId: updated.id,
      siteId: updated.siteId,
      workspaceId: current.site.workspaceId,
      label: updated.name,
      before: auditValues(current),
      after: auditValues(updated),
      fields: AUDIT_FIELDS,
    });
    return updated;
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.StatusReason,
    entityId: reason.id,
    siteId: reason.siteId,
    workspaceId: current.site.workspaceId,
    changedFields: Object.keys(updateData),
  });

  return { data: reason };
}

/**
 * Archive status reason (soft delete via archivedAt)
 */
export async function remove(id: string) {
  const reason = await prisma.statusReason.findUnique({
    where: { id },
    select: { id: true, siteId: true, name: true, archivedAt: true, site: { select: { workspaceId: true } } },
  });

  if (!reason || reason.archivedAt) {
    return { error: "Status reason not found", code: "STATUS_REASON_NOT_FOUND" };
  }

  await prisma.$transaction(async (tx) => {
    await tx.statusReason.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    await auditRecord(tx, {
      change: "deleted",
      entityType: "status-reason",
      entityId: reason.id,
      siteId: reason.siteId,
      workspaceId: reason.site.workspaceId,
      label: reason.name,
      fields: [],
    });
  });

  publishEntityEvent({
    action: "deleted",
    entityKey: SYSTEM_ENTITY_KEYS.StatusReason,
    entityId: reason.id,
    siteId: reason.siteId,
    workspaceId: reason.site.workspaceId,
  });

  return { success: true };
}
