import { randomUUID } from "node:crypto";
import prisma, { Prisma } from "@rw/db";
import type { DocumentTargetType } from "@rw/db";
import {
  applyLabelFilter,
  collectDocumentTreeIds,
  documentInclude,
  normalizeLabels,
  toDocument,
  type LabelFilter,
} from "./shared.js";
import { resolveContext, targetNames } from "./context.js";

export { contextTargets, resolveContext } from "./context.js";
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
  createdById?: string | null;
}

export interface CreateVersionUploadInput {
  filename: string;
  contentType: string;
  size: number;
  createdById?: string | null;
}

export interface ListDocumentsInput {
  siteId?: string | null;
  parentId?: string | null;
  /** Span every folder instead of scoping to `parentId`. */
  allFolders?: boolean;
  kind?: "FILE" | "FOLDER";
  includePending?: boolean;
  labelsAny?: string[];
  labelsAll?: string[];
  q?: string;
  limit?: number;
  offset?: number;
  /** Only documents linked to this record; skips parentId scoping. */
  linkedTo?: { targetType: DocumentTargetType; targetId: string };
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

interface ParentResolution {
  parentId: string | null;
  siteId: string | null;
}

const versionSelect = {
  id: true,
  version: true,
  filename: true,
  contentType: true,
  size: true,
  createdAt: true,
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.DocumentFileSelect;

type VersionRecord = Prisma.DocumentFileGetPayload<{ select: typeof versionSelect }>;

function toVersion({ createdBy, ...file }: VersionRecord, currentFileId: string | null) {
  const name = createdBy ? [createdBy.firstName, createdBy.lastName].filter(Boolean).join(" ") : "";
  return {
    ...file,
    isCurrent: file.id === currentFileId,
    createdBy: createdBy ? { id: createdBy.id, name: name || createdBy.email } : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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

  return { data: toDocument(document) };
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

  // Version 1 is created with the document and is current from the start;
  // the document's status says whether its bytes have landed yet.
  const documentId = randomUUID();
  const fileId = randomUUID();
  const storageKey = storage.generateDocumentKey(documentId, input.filename);
  const [, document] = await prisma.$transaction([
    prisma.document.create({
      data: {
        id: documentId,
        kind: "FILE",
        status: "PENDING_UPLOAD",
        name: input.name ?? input.filename,
        description: input.description ?? null,
        labels: normalizeLabels(input.labels),
        attrs: input.attrs ?? {},
        siteId: location.siteId,
        parentId: location.parentId,
        files: {
          create: {
            id: fileId,
            version: 1,
            filename: input.filename,
            contentType: input.contentType,
            size: input.size,
            storageKey,
            createdById: input.createdById ?? null,
          },
        },
      },
    }),
    prisma.document.update({
      where: { id: documentId },
      data: { currentFileId: fileId },
      include: documentInclude,
    }),
  ]);

  const uploadUrl = await storage.getPresignedUploadUrl(storageKey, input.contentType, input.size);
  return { data: { document: toDocument(document), uploadUrl } };
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
    return { data: toDocument(document) };
  }

  const file = document.currentFile;
  if (!file) {
    return { error: "Document is missing a storage key", code: "MISSING_STORAGE_KEY" };
  }

  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  const exists = await storage.objectExists(file.storageKey);
  if (!exists) {
    return { error: "Uploaded object was not found", code: "UPLOAD_NOT_FOUND" };
  }

  const [, updated] = await prisma.$transaction([
    prisma.documentFile.update({ where: { id: file.id }, data: { status: "READY" } }),
    prisma.document.update({ where: { id: documentId }, data: { status: "READY" }, include: documentInclude }),
  ]);

  return { data: toDocument(updated) };
}

async function findReadyFile(documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, kind: true, status: true, currentFileId: true, deletedAt: true },
  });

  if (!document || document.deletedAt) {
    return { error: "Document not found", code: "DOCUMENT_NOT_FOUND" };
  }

  if (document.kind !== "FILE") {
    return { error: "Folders have no versions", code: "NOT_FILE" };
  }

  if (document.status !== "READY") {
    return { error: "Document upload is not complete", code: "DOCUMENT_PENDING" };
  }

  return { data: document };
}

/**
 * Start uploading a new version of a READY file. The new DocumentFile row is
 * PENDING_UPLOAD and not yet current: readers keep the previous version until
 * completeVersionUpload. Any file type is accepted; the name, folder, labels
 * and links stay on the document.
 */
export async function createVersionUpload(documentId: string, input: CreateVersionUploadInput) {
  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  const validationError = storage.validateDocumentUpload(input.contentType, input.size);
  if (validationError) {
    return { error: validationError, code: "INVALID_UPLOAD" };
  }

  const found = await findReadyFile(documentId);
  if (found.error !== undefined) return found;

  const latest = await prisma.documentFile.aggregate({ where: { documentId }, _max: { version: true } });
  const storageKey = storage.generateDocumentKey(documentId, input.filename);

  let file: VersionRecord;
  try {
    file = await prisma.documentFile.create({
      data: {
        documentId,
        version: (latest._max.version ?? 0) + 1,
        filename: input.filename,
        contentType: input.contentType,
        size: input.size,
        storageKey,
        createdById: input.createdById ?? null,
      },
      select: versionSelect,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { error: "Another version was uploaded at the same time; try again", code: "VERSION_CONFLICT" };
    }
    throw error;
  }

  const uploadUrl = await storage.getPresignedUploadUrl(storageKey, input.contentType, input.size);
  return { data: { version: toVersion(file, found.data.currentFileId), uploadUrl } };
}

async function findPendingVersion(documentId: string, fileId: string) {
  const file = await prisma.documentFile.findUnique({
    where: { id: fileId },
    select: { id: true, documentId: true, version: true, status: true, storageKey: true },
  });

  if (!file || file.documentId !== documentId) {
    return { error: "Version not found", code: "VERSION_NOT_FOUND" };
  }

  return { data: file };
}

/** Confirm a new version's bytes landed and make it the document's current file. */
export async function completeVersionUpload(documentId: string, fileId: string) {
  const found = await findReadyFile(documentId);
  if (found.error !== undefined) return found;

  const pending = await findPendingVersion(documentId, fileId);
  if (pending.error !== undefined) return pending;
  const file = pending.data;

  if (file.status === "PENDING_UPLOAD") {
    if (!storage.isStorageEnabled()) {
      return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
    }

    const exists = await storage.objectExists(file.storageKey);
    if (!exists) {
      return { error: "Uploaded object was not found", code: "UPLOAD_NOT_FOUND" };
    }
  }

  const current = found.data.currentFileId
    ? await prisma.documentFile.findUnique({ where: { id: found.data.currentFileId }, select: { version: true } })
    : null;
  // A slower upload that finishes after a newer one never moves current back.
  const becomesCurrent = !current || file.version > current.version;

  const [, document] = await prisma.$transaction([
    prisma.documentFile.update({ where: { id: file.id }, data: { status: "READY" } }),
    prisma.document.update({
      where: { id: documentId },
      data: becomesCurrent ? { currentFileId: file.id } : {},
      include: documentInclude,
    }),
  ]);

  return { data: toDocument(document) };
}

/** Roll back a version upload that never finished. READY versions are kept. */
export async function cancelVersionUpload(documentId: string, fileId: string) {
  const pending = await findPendingVersion(documentId, fileId);
  if (pending.error !== undefined) return pending;

  if (pending.data.status !== "PENDING_UPLOAD") {
    return { error: "Only an unfinished version can be cancelled", code: "VERSION_READY" };
  }

  await prisma.documentFile.delete({ where: { id: fileId } });

  if (storage.isStorageEnabled()) {
    try {
      await storage.deleteObjects([pending.data.storageKey]);
    } catch {
      // Best effort; nothing points at the object any more.
    }
  }

  return { success: true };
}

/** Every uploaded version of a file, newest first. */
export async function listVersions(documentId: string) {
  const found = await findReadyFile(documentId);
  if (found.error !== undefined) return found;

  const files = await prisma.documentFile.findMany({
    where: { documentId, status: "READY" },
    select: versionSelect,
    orderBy: { version: "desc" },
  });

  return { data: files.map((file) => toVersion(file, found.data.currentFileId)) };
}

async function getVersionFileUrl(documentId: string, fileId: string, disposition: "inline" | "attachment") {
  const found = await findReadyFile(documentId);
  if (found.error !== undefined) return found;

  const file = await prisma.documentFile.findUnique({ where: { id: fileId } });
  if (!file || file.documentId !== documentId || file.status !== "READY") {
    return { error: "Version not found", code: "VERSION_NOT_FOUND" };
  }

  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  const url = await storage.getPresignedDownloadUrl(file.storageKey, {
    disposition,
    filename: file.filename,
    contentType: file.contentType,
  });
  return { data: { url } };
}

export async function getVersionDownloadUrl(documentId: string, fileId: string) {
  return getVersionFileUrl(documentId, fileId, "attachment");
}

export async function getVersionOpenUrl(documentId: string, fileId: string) {
  return getVersionFileUrl(documentId, fileId, "inline");
}

export async function list(input: ListDocumentsInput = {}) {
  const {
    siteId,
    parentId = null,
    allFolders = false,
    kind,
    includePending = false,
    q,
    limit = 50,
    offset = 0,
    linkedTo,
  } = input;
  const where: Prisma.DocumentWhereInput = {
    deletedAt: null,
    // Linked-document and all-folder queries span the whole folder tree.
    ...(linkedTo || allFolders ? {} : { parentId }),
    ...(kind ? { kind } : {}),
    ...(includePending ? {} : { status: "READY" }),
  };

  if (linkedTo) {
    where.links = { some: { targetType: linkedTo.targetType, targetId: linkedTo.targetId } };
  }

  if (siteId !== undefined) {
    where.siteId = siteId;
  }

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
      { currentFile: { filename: { contains: q, mode: "insensitive" } } },
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

  return { data: documents.map(toDocument), total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(documentId: string, options: { includePending?: boolean } = {}) {
  const document = await prisma.document.findUnique({ where: { id: documentId }, include: documentInclude });

  if (!document || document.deletedAt) {
    return null;
  }

  if (!options.includePending && document.status !== "READY") {
    return { error: "Document upload is not complete", code: "DOCUMENT_PENDING" };
  }

  const names = await targetNames(document.links);
  return {
    data: {
      ...toDocument(document),
      links: document.links.map((link) => ({
        ...link,
        targetName: names.get(`${link.targetType}:${link.targetId}`) ?? null,
      })),
    },
  };
}

async function getDocumentFileUrl(documentId: string, disposition: "inline" | "attachment") {
  const document = await prisma.document.findUnique({ where: { id: documentId }, include: documentInclude });

  if (!document || document.deletedAt) {
    return { error: "Document not found", code: "DOCUMENT_NOT_FOUND" };
  }

  if (document.kind !== "FILE") {
    return { error: "Folders cannot be opened or downloaded", code: "NOT_FILE" };
  }

  if (document.status !== "READY") {
    return { error: "Document upload is not complete", code: "DOCUMENT_PENDING" };
  }

  const file = document.currentFile;
  if (!file) {
    return { error: "Document is missing a storage key", code: "MISSING_STORAGE_KEY" };
  }

  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  const url = await storage.getPresignedDownloadUrl(file.storageKey, {
    disposition,
    filename: file.filename,
    contentType: file.contentType,
  });
  return { data: { document: toDocument(document), url } };
}

export async function getDownloadUrl(documentId: string) {
  return getDocumentFileUrl(documentId, "attachment");
}

export async function getOpenUrl(documentId: string) {
  return getDocumentFileUrl(documentId, "inline");
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
  return { data: toDocument(document) };
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
  // Every version's bytes go, not just the current one.
  const files = await prisma.documentFile.findMany({
    where: { documentId: { in: ids } },
    select: { storageKey: true },
  });
  const storageKeys = files.map((file) => file.storageKey);

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
  if ("error" in target) return { error: target.error, code: target.code };

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

  return { data: links.map((link) => toDocument(link.document)) };
}

/**
 * A terminal's documents: the knowledge context of its station (current job,
 * its parts, tools and materials, then workcenter and site), or of its
 * workcenter or site when it shows no station. See context.ts.
 */
export async function listForDisplayContext(context: DisplayDocumentContext, filter: LabelFilter = {}) {
  const station = context.stationId
    ? await prisma.station.findUnique({
        where: { id: context.stationId },
        select: { id: true, siteId: true, deletedAt: true },
      })
    : null;
  const root: { targetType: DocumentTargetType; targetId: string } =
    station && !station.deletedAt && station.siteId === context.siteId
      ? { targetType: "STATION", targetId: station.id }
      : context.workcenterId
        ? { targetType: "WORKCENTER", targetId: context.workcenterId }
        : { targetType: "SITE", targetId: context.siteId };

  const result = await resolveContext(root, filter);
  if ("error" in result) return { data: [] };
  return { data: result.data.map((item) => item.document) };
}
