import prisma from "@rw/db";
import type { ClassificationKind, Prisma } from "@rw/db";

// One shared list of labels per site, used by jobs, tools, products,
// materials, and stations. kind GROUP = a plain label for grouping and
// filtering. kind CAPABILITY = a matching label: machines say what they can
// do, jobs say what they need, and changeJob refuses a station that is
// missing any label the job requires. Deleting a label really deletes it —
// it disappears from every record at once and stops enforcing anything.

export interface CreateClassificationInput {
  siteId: string;
  name: string;
  kind?: ClassificationKind;
  attrs?: Record<string, unknown>;
}

export interface UpdateClassificationInput {
  name?: string;
  kind?: ClassificationKind;
  attrs?: Record<string, unknown>;
}

export interface ListClassificationsFilter {
  siteId?: string;
  kind?: ClassificationKind;
  /** Case-insensitive contains on name. */
  q?: string;
  limit?: number;
  offset?: number;
}

const usageCount = {
  _count: { select: { jobs: true, tools: true, products: true, materials: true, stations: true } },
} as const;

export async function create(input: CreateClassificationInput) {
  const { siteId, name, kind, attrs } = input;

  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const existing = await prisma.classification.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { id: true },
  });
  if (existing) {
    return { error: "A classification with this name already exists for this site", code: "DUPLICATE_NAME" };
  }

  const classification = await prisma.classification.create({
    data: { siteId, name, kind: kind ?? "GROUP", attrs: attrs ?? {} },
    include: usageCount,
  });
  return { data: classification };
}

export async function list(filter: ListClassificationsFilter = {}) {
  const { siteId, kind, q, limit = 50, offset = 0 } = filter;

  const where: Prisma.ClassificationWhereInput = {};
  if (siteId) where.siteId = siteId;
  if (kind) where.kind = kind;
  if (q) where.name = { contains: q, mode: "insensitive" };

  const [classifications, total] = await Promise.all([
    prisma.classification.findMany({
      where,
      include: usageCount,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.classification.count({ where }),
  ]);

  return { data: classifications, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string) {
  const classification = await prisma.classification.findUnique({ where: { id }, include: usageCount });
  if (!classification) return null;
  return { data: classification };
}

export async function update(id: string, input: UpdateClassificationInput) {
  const { name, kind, attrs } = input;

  const current = await prisma.classification.findUnique({ where: { id }, select: { id: true, siteId: true } });
  if (!current) {
    return { error: "Classification not found", code: "CLASSIFICATION_NOT_FOUND" };
  }

  if (name !== undefined) {
    const duplicate = await prisma.classification.findUnique({
      where: { siteId_name: { siteId: current.siteId, name } },
      select: { id: true },
    });
    if (duplicate && duplicate.id !== id) {
      return { error: "A classification with this name already exists for this site", code: "DUPLICATE_NAME" };
    }
  }

  const data: Prisma.ClassificationUpdateInput = {};
  if (name !== undefined) data.name = name;
  if (kind !== undefined) data.kind = kind;
  if (attrs !== undefined) data.attrs = attrs;

  const classification = await prisma.classification.update({ where: { id }, data, include: usageCount });
  return { data: classification };
}

export async function remove(id: string) {
  const current = await prisma.classification.findUnique({ where: { id }, select: { id: true } });
  if (!current) {
    return { error: "Classification not found", code: "CLASSIFICATION_NOT_FOUND" };
  }
  await prisma.classification.delete({ where: { id } });
  return { success: true };
}
