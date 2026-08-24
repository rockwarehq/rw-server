import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

// One shared list of labels per site, used by jobs, tools, products,
// materials, stations, status/downtime codes, and scrap codes. Labels
// organize things, filter lists, and slice reports. Station filters
// (LabelFilter) use them to decide what a station accepts and what its
// operator screens offer. Deleting a label really deletes it — it
// disappears from every record and every filter at once.

export interface CreateLabelInput {
  siteId: string;
  name: string;
  attrs?: Record<string, unknown>;
}

export interface UpdateLabelInput {
  name?: string;
  attrs?: Record<string, unknown>;
}

export interface ListLabelsFilter {
  siteId?: string;
  /** Case-insensitive contains on name. */
  q?: string;
  limit?: number;
  offset?: number;
}

const usageCount = {
  _count: {
    select: {
      jobs: true,
      tools: true,
      products: true,
      materials: true,
      stations: true,
      statusReasons: true,
      itemDispositionReasons: true,
      labelFilters: true,
    },
  },
} as const;

export async function create(input: CreateLabelInput) {
  const { siteId, name, attrs } = input;

  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const existing = await prisma.label.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { id: true },
  });
  if (existing) {
    return { error: "A label with this name already exists for this site", code: "DUPLICATE_NAME" };
  }

  const label = await prisma.label.create({
    data: { siteId, name, attrs: attrs ?? {} },
    include: usageCount,
  });
  return { data: label };
}

export async function list(filter: ListLabelsFilter = {}) {
  const { siteId, q, limit = 50, offset = 0 } = filter;

  const where: Prisma.LabelWhereInput = {};
  if (siteId) where.siteId = siteId;
  if (q) where.name = { contains: q, mode: "insensitive" };

  const [labels, total] = await Promise.all([
    prisma.label.findMany({
      where,
      include: usageCount,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.label.count({ where }),
  ]);

  return { data: labels, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string) {
  const label = await prisma.label.findUnique({ where: { id }, include: usageCount });
  if (!label) return null;
  return { data: label };
}

export async function update(id: string, input: UpdateLabelInput) {
  const { name, attrs } = input;

  const current = await prisma.label.findUnique({ where: { id }, select: { id: true, siteId: true } });
  if (!current) {
    return { error: "Label not found", code: "LABEL_NOT_FOUND" };
  }

  if (name !== undefined) {
    const duplicate = await prisma.label.findUnique({
      where: { siteId_name: { siteId: current.siteId, name } },
      select: { id: true },
    });
    if (duplicate && duplicate.id !== id) {
      return { error: "A label with this name already exists for this site", code: "DUPLICATE_NAME" };
    }
  }

  const data: Prisma.LabelUpdateInput = {};
  if (name !== undefined) data.name = name;
  if (attrs !== undefined) data.attrs = attrs;

  const label = await prisma.label.update({ where: { id }, data, include: usageCount });
  return { data: label };
}

export async function remove(id: string) {
  const current = await prisma.label.findUnique({ where: { id }, select: { id: true } });
  if (!current) {
    return { error: "Label not found", code: "LABEL_NOT_FOUND" };
  }
  await prisma.label.delete({ where: { id } });
  return { success: true };
}
