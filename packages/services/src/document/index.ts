import prisma from "@rw/db";
import type { DocumentTargetType, Prisma } from "@rw/db";
import * as storage from "@rw/runtime/storage";

export interface CreateFolderInput {
  name: string;
  description?: string;
  labels?: string[];
  siteId?: string | null;
  parentId?: string | null;
  attrs?: Record<string, unknown>;
  workspaceId?: string;
}

export interface CreateUploadInput {
  name?: string;
  description?: string;
  labels?: string[];
  filename: string;
  contentType: string;
  size: number;
  siteId?: string | null;
  parentId?: string | null;
  attrs?: Record<string, unknown>;
  workspaceId?: string;
}

export interface ListDocumentsInput {
  siteId?: string | null;
  parentId?: string | null;
  kind?: "FILE" | "FOLDER";
  includePending?: boolean;
  labelsAny?: string[];
  labelsAll?: string[];
  q?: string;
  limit?: number;
  offset?: number;
}

export interface UpdateDocumentInput {
  name?: string;
  description?: string | null;
  labels?: string[];
  parentId?: string | null;
  attrs?: Record<string, unknown>;
}

export interface DisplayDocumentContext {
  siteId: string;
  workcenterId?: string | null;
  stationId?: string | null;
}

interface TargetRef {
  targetType: DocumentTargetType;
  targetId: string;
}

interface LabelFilter {
  labelsAny?: string[];
  labelsAll?: string[];
}

interface ParentResolution {
  parentId: string | null;
  siteId: string | null;
}

const documentInclude = {
  site: { select: { id: true, name: true } },
  parent: { select: { id: true, name: true, kind: true } },
  links: true,
} satisfies Prisma.DocumentInclude;

function uniqueTargets(targets: TargetRef[]): TargetRef[] {
  const seen = new Set<string>();
  const out: TargetRef[] = [];
  for (const target of targets) {
    const key = `${target.targetType}:${target.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLabels(labels?: string[]): string[] {
  if (!labels) return [];
  return [...new Set(labels.map(normalizeLabel).filter(Boolean))];
}

function applyLabelFilter(where: Prisma.DocumentWhereInput, filter: LabelFilter): void {
  const labelsAny = normalizeLabels(filter.labelsAny);
  const labelsAll = normalizeLabels(filter.labelsAll);

  if (labelsAny.length > 0) {
    where.labels = { hasSome: labelsAny };
  }

  if (labelsAll.length > 0) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { labels: { hasEvery: labelsAll } }];
  }
}

async function validateSite(
  siteId: string,
  workspaceId?: string,
): Promise<{ id: string } | { error: string; code: string }> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  if (workspaceId && site.workspaceId !== workspaceId) {
    return { error: "Site does not belong to this workspace", code: "SITE_NOT_IN_WORKSPACE" };
  }

  return { id: site.id };
}

async function resolveParentAndSite(input: {
  parentId?: string | null;
  siteId?: string | null;
  workspaceId?: string;
}): Promise<ParentResolution | { error: string; code: string }> {
  let siteId = input.siteId ?? null;
  const parentId = input.parentId ?? null;

  if (siteId) {
    const site = await validateSite(siteId, input.workspaceId);
    if ("error" in site) return site;
  }

  if (!parentId) {
    return { parentId: null, siteId };
  }

  const parent = await prisma.document.findUnique({
    where: { id: parentId },
    select: { id: true, kind: true, siteId: true, deletedAt: true },
  });

  if (!parent || parent.deletedAt) {
    return { error: "Parent folder not found", code: "PARENT_NOT_FOUND" };
  }

  if (parent.kind !== "FOLDER") {
    return { error: "Parent must be a folder", code: "PARENT_NOT_FOLDER" };
  }

  if (siteId && parent.siteId !== siteId) {
    return { error: "Parent folder must belong to the same site scope", code: "SITE_MISMATCH" };
  }

  siteId = parent.siteId;
  return { parentId, siteId };
}

async function resolveTargetSite(
  targetType: DocumentTargetType,
  targetId: string,
): Promise<{ siteId: string } | { error: string; code: string }> {
  switch (targetType) {
    case "SITE": {
      const site = await prisma.site.findUnique({ where: { id: targetId }, select: { id: true } });
      return site ? { siteId: site.id } : { error: "Site not found", code: "TARGET_NOT_FOUND" };
    }
    case "WORKCENTER": {
      const workcenter = await prisma.workcenter.findUnique({ where: { id: targetId }, select: { siteId: true } });
      return workcenter ? { siteId: workcenter.siteId } : { error: "Workcenter not found", code: "TARGET_NOT_FOUND" };
    }
    case "STATION": {
      const station = await prisma.station.findUnique({
        where: { id: targetId },
        select: { siteId: true, deletedAt: true },
      });
      return station && !station.deletedAt
        ? { siteId: station.siteId }
        : { error: "Station not found", code: "TARGET_NOT_FOUND" };
    }
    case "JOB": {
      const job = await prisma.job.findUnique({ where: { id: targetId }, select: { siteId: true, deletedAt: true } });
      return job && !job.deletedAt ? { siteId: job.siteId } : { error: "Job not found", code: "TARGET_NOT_FOUND" };
    }
    case "TOOL": {
      const tool = await prisma.tool.findUnique({ where: { id: targetId }, select: { siteId: true, deletedAt: true } });
      return tool && !tool.deletedAt ? { siteId: tool.siteId } : { error: "Tool not found", code: "TARGET_NOT_FOUND" };
    }
    case "PRODUCT": {
      const product = await prisma.product.findUnique({
        where: { id: targetId },
        select: { siteId: true, deletedAt: true },
      });
      return product && !product.deletedAt
        ? { siteId: product.siteId }
        : { error: "Product not found", code: "TARGET_NOT_FOUND" };
    }
    case "MATERIAL": {
      const material = await prisma.material.findUnique({
        where: { id: targetId },
        select: { siteId: true, deletedAt: true },
      });
      return material && !material.deletedAt
        ? { siteId: material.siteId }
        : { error: "Material not found", code: "TARGET_NOT_FOUND" };
    }
  }
}

async function collectDocumentTreeIds(rootId: string): Promise<string[]> {
  const ids = [rootId];
  let frontier = [rootId];

  while (frontier.length > 0) {
    const children = await prisma.document.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((item) => item.id);
    ids.push(...frontier);
  }

  return ids;
}

export async function createFolder(input: CreateFolderInput) {
  const location = await resolveParentAndSite(input);
  if ("error" in location) return location;

  const document = await prisma.document.create({
    data: {
      kind: "FOLDER",
      status: "READY",
      name: input.name,
      description: input.description ?? null,
      labels: normalizeLabels(input.labels),
      attrs: input.attrs ?? {},
      siteId: location.siteId,
      parentId: location.parentId,
    },
    include: documentInclude,
  });

  return { data: document };
}

export async function createUpload(input: CreateUploadInput) {
  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  const validationError = storage.validateDocumentUpload(input.contentType, input.size);
  if (validationError) {
    return { error: validationError, code: "INVALID_UPLOAD" };
  }

  const location = await resolveParentAndSite(input);
  if ("error" in location) return location;

  const document = await prisma.document.create({
    data: {
      kind: "FILE",
      status: "PENDING_UPLOAD",
      name: input.name ?? input.filename,
      description: input.description ?? null,
      labels: normalizeLabels(input.labels),
      attrs: input.attrs ?? {},
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      siteId: location.siteId,
      parentId: location.parentId,
    },
    include: documentInclude,
  });

  const storageKey = storage.generateDocumentKey(document.id, input.filename);
  const [updated, uploadUrl] = await Promise.all([
    prisma.document.update({ where: { id: document.id }, data: { storageKey }, include: documentInclude }),
    storage.getPresignedUploadUrl(storageKey, input.contentType, input.size),
  ]);

  return { data: { document: updated, uploadUrl } };
}

export async function completeUpload(documentId: string) {
  const document = await prisma.document.findUnique({ where: { id: documentId }, include: documentInclude });

  if (!document || document.deletedAt) {
    return { error: "Document not found", code: "DOCUMENT_NOT_FOUND" };
  }

  if (document.kind !== "FILE") {
    return { error: "Only files can complete upload", code: "NOT_FILE" };
  }

  if (document.status === "READY") {
    return { data: document };
  }

  if (!document.storageKey) {
    return { error: "Document is missing a storage key", code: "MISSING_STORAGE_KEY" };
  }

  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  const exists = await storage.objectExists(document.storageKey);
  if (!exists) {
    return { error: "Uploaded object was not found", code: "UPLOAD_NOT_FOUND" };
  }

  const updated = await prisma.document.update({
    where: { id: documentId },
    data: { status: "READY" },
    include: documentInclude,
  });

  return { data: updated };
}

export async function list(input: ListDocumentsInput = {}) {
  const { siteId, parentId = null, kind, includePending = false, q, limit = 50, offset = 0 } = input;
  const where: Prisma.DocumentWhereInput = {
    deletedAt: null,
    parentId,
    ...(kind ? { kind } : {}),
    ...(includePending ? {} : { status: "READY" }),
  };

  if (siteId !== undefined) {
    where.siteId = siteId;
  }

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
      { filename: { contains: q, mode: "insensitive" } },
    ];
  }

  applyLabelFilter(where, input);

  const [documents, total] = await Promise.all([
    prisma.document.findMany({
      where,
      include: documentInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: [{ kind: "desc" }, { name: "asc" }],
    }),
    prisma.document.count({ where }),
  ]);

  return { data: documents, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(documentId: string, options: { includePending?: boolean } = {}) {
  const document = await prisma.document.findUnique({ where: { id: documentId }, include: documentInclude });

  if (!document || document.deletedAt) {
    return null;
  }

  if (!options.includePending && document.status !== "READY") {
    return { error: "Document upload is not complete", code: "DOCUMENT_PENDING" };
  }

  return { data: document };
}

export async function getDownloadUrl(documentId: string) {
  const document = await prisma.document.findUnique({ where: { id: documentId }, include: documentInclude });

  if (!document || document.deletedAt) {
    return { error: "Document not found", code: "DOCUMENT_NOT_FOUND" };
  }

  if (document.kind !== "FILE") {
    return { error: "Folders cannot be downloaded", code: "NOT_FILE" };
  }

  if (document.status !== "READY") {
    return { error: "Document upload is not complete", code: "DOCUMENT_PENDING" };
  }

  if (!document.storageKey) {
    return { error: "Document is missing a storage key", code: "MISSING_STORAGE_KEY" };
  }

  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  const url = await storage.getPresignedDownloadUrl(document.storageKey);
  return { data: { document, url } };
}

export async function update(documentId: string, input: UpdateDocumentInput) {
  const current = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, kind: true, siteId: true, parentId: true, deletedAt: true },
  });

  if (!current || current.deletedAt) {
    return { error: "Document not found", code: "DOCUMENT_NOT_FOUND" };
  }

  const data: Prisma.DocumentUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.attrs !== undefined) data.attrs = input.attrs;
  if (input.labels !== undefined) data.labels = normalizeLabels(input.labels);

  if (input.parentId !== undefined) {
    if (input.parentId === documentId) {
      return { error: "Document cannot be its own parent", code: "INVALID_PARENT" };
    }

    if (input.parentId && current.kind === "FOLDER") {
      const treeIds = await collectDocumentTreeIds(documentId);
      if (treeIds.includes(input.parentId)) {
        return { error: "Folder cannot be moved into its own descendant", code: "INVALID_PARENT" };
      }
    }

    const location = await resolveParentAndSite({ parentId: input.parentId, siteId: current.siteId });
    if ("error" in location) return location;
    data.parent = location.parentId ? { connect: { id: location.parentId } } : { disconnect: true };
    if (location.siteId !== current.siteId) {
      data.site = location.siteId ? { connect: { id: location.siteId } } : { disconnect: true };
    }
  }

  const document = await prisma.document.update({ where: { id: documentId }, data, include: documentInclude });
  return { data: document };
}

export async function remove(documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, deletedAt: true },
  });

  if (!document || document.deletedAt) {
    return { error: "Document not found", code: "DOCUMENT_NOT_FOUND" };
  }

  const ids = await collectDocumentTreeIds(documentId);
  const files = await prisma.document.findMany({
    where: { id: { in: ids }, kind: "FILE", storageKey: { not: null } },
    select: { storageKey: true },
  });
  const storageKeys = files.map((file) => file.storageKey).filter((key): key is string => !!key);

  await prisma.document.deleteMany({ where: { id: { in: ids } } });

  if (storageKeys.length > 0 && storage.isStorageEnabled()) {
    try {
      await storage.deleteObjects(storageKeys);
    } catch {
      // Keep deletion idempotent; orphan cleanup can retry by storage prefix later.
    }
  }

  return { success: true };
}

export async function link(documentId: string, targetType: DocumentTargetType, targetId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!document || document.deletedAt) {
    return { error: "Document not found", code: "DOCUMENT_NOT_FOUND" };
  }

  const target = await resolveTargetSite(targetType, targetId);
  if ("error" in target) return target;

  if (document.siteId && document.siteId !== target.siteId) {
    return { error: "Document and target must belong to the same site", code: "SITE_MISMATCH" };
  }

  const documentLink = await prisma.documentLink.upsert({
    where: { documentId_targetType_targetId: { documentId, targetType, targetId } },
    create: { documentId, targetType, targetId },
    update: {},
  });

  return { data: documentLink };
}

export async function unlink(documentId: string, targetType: DocumentTargetType, targetId: string) {
  await prisma.documentLink.deleteMany({ where: { documentId, targetType, targetId } });
  return { success: true };
}

export async function listForTarget(targetType: DocumentTargetType, targetId: string, filter: LabelFilter = {}) {
  const documentWhere: Prisma.DocumentWhereInput = { deletedAt: null, status: "READY" };
  applyLabelFilter(documentWhere, filter);

  const links = await prisma.documentLink.findMany({
    where: {
      targetType,
      targetId,
      document: documentWhere,
    },
    include: { document: { include: documentInclude } },
    orderBy: { createdAt: "desc" },
  });

  return { data: links.map((link) => link.document) };
}

export async function listForTargets(targets: TargetRef[], siteId?: string, filter: LabelFilter = {}) {
  const unique = uniqueTargets(targets);
  if (unique.length === 0) {
    return { data: [] };
  }

  const documentWhere: Prisma.DocumentWhereInput = {
    deletedAt: null,
    status: "READY",
    ...(siteId ? { OR: [{ siteId: null }, { siteId }] } : {}),
  };
  applyLabelFilter(documentWhere, filter);

  const links = await prisma.documentLink.findMany({
    where: {
      OR: unique.map((target) => ({ targetType: target.targetType, targetId: target.targetId })),
      document: documentWhere,
    },
    include: { document: { include: documentInclude } },
    orderBy: { createdAt: "desc" },
  });

  const seen = new Set<string>();
  const documents = [];
  for (const link of links) {
    if (seen.has(link.documentId)) continue;
    seen.add(link.documentId);
    documents.push(link.document);
  }

  return { data: documents };
}

export async function listForDisplayContext(context: DisplayDocumentContext, filter: LabelFilter = {}) {
  const targets: TargetRef[] = [{ targetType: "SITE", targetId: context.siteId }];

  if (context.workcenterId) {
    targets.push({ targetType: "WORKCENTER", targetId: context.workcenterId });
  }

  if (context.stationId) {
    const station = await prisma.station.findUnique({
      where: { id: context.stationId },
      select: {
        id: true,
        siteId: true,
        workcenterId: true,
        currentJobId: true,
        deletedAt: true,
      },
    });

    if (station && !station.deletedAt && station.siteId === context.siteId) {
      targets.push({ targetType: "STATION", targetId: station.id });
      if (station.workcenterId) {
        targets.push({ targetType: "WORKCENTER", targetId: station.workcenterId });
      }

      if (station.currentJobId) {
        targets.push({ targetType: "JOB", targetId: station.currentJobId });
        const job = await prisma.job.findUnique({
          where: { id: station.currentJobId },
          select: {
            tools: { where: { deletedAt: null }, select: { toolId: true } },
            jobProducts: {
              where: { deletedAt: null },
              select: {
                productId: true,
                toolId: true,
                product: { select: { materials: { where: { archivedAt: null }, select: { materialId: true } } } },
              },
            },
          },
        });

        for (const jobTool of job?.tools ?? []) {
          targets.push({ targetType: "TOOL", targetId: jobTool.toolId });
        }
        for (const jobProduct of job?.jobProducts ?? []) {
          targets.push({ targetType: "PRODUCT", targetId: jobProduct.productId });
          if (jobProduct.toolId) {
            targets.push({ targetType: "TOOL", targetId: jobProduct.toolId });
          }
          for (const productMaterial of jobProduct.product.materials) {
            targets.push({ targetType: "MATERIAL", targetId: productMaterial.materialId });
          }
        }
      }
    }
  }

  return listForTargets(targets, context.siteId, filter);
}
