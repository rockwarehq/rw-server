import { z } from "zod";
import { ORPCError } from "@orpc/server";
import type { DocumentTargetType } from "@rw/db";
import * as documents from "@rw/services/document/index";
import { storageConfig } from "../config.js";
import type { DisplayCurrent } from "@rw/auth/context";
import { userRequired, displayRequired, userOrDisplayRequired } from "./middleware.js";
import { throwServiceError } from "./errors.js";

const documentTargetTypeSchema = z.enum(["SITE", "WORKCENTER", "STATION", "JOB", "TOOL", "PRODUCT", "MATERIAL"]);

const attrsSchema = z.record(z.string(), z.unknown());
const labelsSchema = z.array(z.string().min(1).max(80)).max(50);

const documentIdInputSchema = z.object({
  documentId: z.uuid(),
});

/**
 * get/open/download: a display may name the station whose context it is
 * reading from (an operator screen serving several stations). User callers'
 * stationId is ignored.
 */
const readDocumentInputSchema = documentIdInputSchema.extend({
  stationId: z.uuid().optional(),
});

const createFolderInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  labels: labelsSchema.optional(),
  siteId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  attrs: attrsSchema.optional(),
});

const uploadFileSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().refine((ct) => storageConfig.allowedDocumentContentTypes.includes(ct), {
    message: `Content type must be one of: ${storageConfig.allowedDocumentContentTypes.join(", ")}`,
  }),
  size: z
    .number()
    .int()
    .positive()
    .max(storageConfig.maxDocumentFileSizeBytes, {
      message: `File size must not exceed ${storageConfig.maxDocumentFileSizeBytes / (1024 * 1024)}MB`,
    }),
});

const createUploadInputSchema = uploadFileSchema.extend({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  labels: labelsSchema.optional(),
  siteId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  attrs: attrsSchema.optional(),
});

/** A new version of an existing file; any allowed type, not only the current one. */
const createVersionUploadInputSchema = uploadFileSchema.extend({
  documentId: z.uuid(),
});

const versionInputSchema = z.object({
  documentId: z.uuid(),
  fileId: z.uuid(),
});

const listInputSchema = z.object({
  siteId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  /** Span every folder instead of scoping to `parentId`. */
  allFolders: z.boolean().default(false),
  /** Without a kind: files and folders. Forms are listed with kind FORM (or form.list). */
  kind: z.enum(["FILE", "FOLDER", "FORM"]).optional(),
  includePending: z.boolean().default(false),
  labelsAny: labelsSchema.optional(),
  labelsAll: labelsSchema.optional(),
  q: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
  linkedTo: z.object({ targetType: documentTargetTypeSchema, targetId: z.uuid() }).optional(),
});

const updateInputSchema = z.object({
  documentId: z.uuid(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  labels: labelsSchema.optional(),
  parentId: z.uuid().nullable().optional(),
  attrs: attrsSchema.optional(),
});

const documentLinkInputSchema = z.object({
  documentId: z.uuid(),
  targetType: documentTargetTypeSchema,
  targetId: z.uuid(),
});

const targetInputSchema = z.object({
  targetType: documentTargetTypeSchema,
  targetId: z.uuid(),
  labelsAny: labelsSchema.optional(),
  labelsAll: labelsSchema.optional(),
});

const contextInputSchema = z.object({
  targetType: documentTargetTypeSchema,
  targetId: z.uuid(),
  /** STATION only: resolve this job instead of the one the station runs now. */
  jobId: z.uuid().nullable().optional(),
  labelsAny: labelsSchema.optional(),
  labelsAll: labelsSchema.optional(),
});

/** The access row that authorizes reading a target's context. */
function contextAccessTarget(targetType: DocumentTargetType, id: string) {
  switch (targetType) {
    case "SITE":
      return { site: id };
    case "WORKCENTER":
      return { workcenter: id };
    case "STATION":
      return { station: id };
    case "JOB":
      return { job: id };
    case "TOOL":
      return { tool: id };
    case "PRODUCT":
      return { product: id };
    case "MATERIAL":
      return { material: id };
  }
}

const labelFilterInputSchema = z.object({
  labelsAny: labelsSchema.optional(),
  labelsAll: labelsSchema.optional(),
});

const displayContextInputSchema = labelFilterInputSchema.optional();

const displayKnowledgeContextInputSchema = labelFilterInputSchema
  .extend({
    /** A station in the display's site (and workcenter, when bound); defaults to the display's own. */
    stationId: z.uuid().optional(),
  })
  .optional();

function getLabelFilter(input?: { labelsAny?: string[]; labelsAll?: string[] }) {
  return {
    labelsAny: input?.labelsAny,
    labelsAll: input?.labelsAll,
  };
}

function getDisplayDocumentContext(display: DisplayCurrent) {
  return {
    siteId: display.siteId,
    workcenterId: display.display.workcenterId,
    stationId: display.display.stationId,
  };
}

/**
 * A display reads a document only when it is in the knowledge context it can
 * see: the chosen station's (validated against the display's site and
 * workcenter), else its own station's, workcenter's or site's.
 */
async function assertDisplayCanAccessDocument(display: DisplayCurrent, documentId: string, stationId?: string) {
  const result = await documents.resolveDisplayContext(getDisplayDocumentContext(display), stationId);
  if ("error" in result) throw new ORPCError("NOT_FOUND", { message: "Document not found" });
  if (!result.data.some((item) => item.document.id === documentId)) {
    throw new ORPCError("NOT_FOUND", { message: "Document not found" });
  }
}

export const createFolder = userRequired.input(createFolderInputSchema).handler(async ({ input, context }) => {
  if (input.siteId) await context.access.require("MANAGE", { site: input.siteId });
  else context.access.requireSomewhere("MANAGE");

  const result = await documents.createFolder({ ...input, workspaceId: context.current.workspaceId });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const createUpload = userRequired.input(createUploadInputSchema).handler(async ({ input, context }) => {
  if (input.siteId) await context.access.require("MANAGE", { site: input.siteId });
  else context.access.requireSomewhere("MANAGE");

  const result = await documents.createUpload({
    ...input,
    workspaceId: context.current.workspaceId,
    createdById: context.current.user.id,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const completeUpload = userRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const result = await documents.completeUpload(input.documentId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const createVersionUpload = userRequired
  .input(createVersionUploadInputSchema)
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { document: input.documentId });

    const { documentId, ...file } = input;
    const result = await documents.createVersionUpload(documentId, { ...file, createdById: context.current.user.id });
    if ("error" in result) throwServiceError(result);
    return result.data;
  });

export const completeVersionUpload = userRequired.input(versionInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const result = await documents.completeVersionUpload(input.documentId, input.fileId);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const cancelVersionUpload = userRequired.input(versionInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const result = await documents.cancelVersionUpload(input.documentId, input.fileId);
  if ("error" in result) throwServiceError(result);
  return { success: true };
});

/** Make an older (or any) finished version the current one. */
export const setCurrentVersion = userRequired.input(versionInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const result = await documents.setCurrentVersion(input.documentId, input.fileId);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const listVersions = userRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { document: input.documentId });

  const result = await documents.listVersions(input.documentId);
  if ("error" in result) throwServiceError(result);
  return { data: result.data };
});

export const openVersion = userRequired.input(versionInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { document: input.documentId });

  const result = await documents.getVersionOpenUrl(input.documentId, input.fileId);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const downloadVersion = userRequired.input(versionInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { document: input.documentId });

  const result = await documents.getVersionDownloadUrl(input.documentId, input.fileId);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  if (input.siteId) await context.access.require("VIEW", { site: input.siteId });
  else context.access.requireSomewhere("VIEW");

  return documents.list(input);
});

export const get = userOrDisplayRequired.input(readDocumentInputSchema).handler(async ({ input, context }) => {
  if (context.current.kind === "display") {
    await assertDisplayCanAccessDocument(context.current, input.documentId, input.stationId);
    const result = await documents.getById(input.documentId);
    if (!result) throw new ORPCError("NOT_FOUND", { message: "Document not found" });
    if (result.error !== undefined) throwServiceError(result);
    return result.data;
  }

  await context.access.require("VIEW", { document: input.documentId });

  const result = await documents.getById(input.documentId, { includePending: true });
  if (!result) throw new ORPCError("NOT_FOUND", { message: "Document not found" });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const download = userOrDisplayRequired.input(readDocumentInputSchema).handler(async ({ input, context }) => {
  if (context.current.kind === "display") {
    await assertDisplayCanAccessDocument(context.current, input.documentId, input.stationId);
  } else {
    await context.access.require("VIEW", { document: input.documentId });
  }

  const result = await documents.getDownloadUrl(input.documentId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const open = userOrDisplayRequired.input(readDocumentInputSchema).handler(async ({ input, context }) => {
  if (context.current.kind === "display") {
    await assertDisplayCanAccessDocument(context.current, input.documentId, input.stationId);
  } else {
    await context.access.require("VIEW", { document: input.documentId });
  }

  const result = await documents.getOpenUrl(input.documentId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const { documentId, ...updateData } = input;
  const result = await documents.update(documentId, updateData);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const remove = userRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const result = await documents.remove(input.documentId);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

export const link = userRequired.input(documentLinkInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const result = await documents.link(input.documentId, input.targetType as DocumentTargetType, input.targetId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const unlink = userRequired.input(documentLinkInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  return documents.unlink(input.documentId, input.targetType as DocumentTargetType, input.targetId);
});

export const listForTarget = userRequired.input(targetInputSchema).handler(async ({ input, context }) => {
  context.access.requireSomewhere("VIEW");

  return documents.listForTarget(input.targetType as DocumentTargetType, input.targetId, getLabelFilter(input));
});

/**
 * A record's knowledge context: every document linked to it or to what it is
 * made of and runs with, most specific first, each with the records it came
 * through and its current version. See services/document/context.ts.
 */
export const context = userRequired.input(contextInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", contextAccessTarget(input.targetType, input.targetId));

  const result = await documents.resolveContext(
    { targetType: input.targetType as DocumentTargetType, targetId: input.targetId },
    { jobId: input.jobId, ...getLabelFilter(input) },
  );
  if ("error" in result) throwServiceError(result);
  return { data: result.data, targets: result.targets };
});

export const listForDisplayContext = displayRequired
  .input(displayContextInputSchema)
  .handler(async ({ input, context }) => {
    return documents.listForDisplayContext(getDisplayDocumentContext(context.current), getLabelFilter(input));
  });

/**
 * A terminal's knowledge context, in the same shape as `context`: each file
 * with the records it came through (`via`), its folder and current version.
 * Rooted at `stationId` (which must be live in the display's site and, when
 * the display is bound to one, its workcenter — else NOT_FOUND), else the
 * display's own station, workcenter or site.
 */
export const displayContext = displayRequired
  .input(displayKnowledgeContextInputSchema)
  .handler(async ({ input, context }) => {
    const result = await documents.resolveDisplayContext(
      getDisplayDocumentContext(context.current),
      input?.stationId,
      getLabelFilter(input),
    );
    if ("error" in result) throwServiceError(result);
    return { data: result.data, targets: result.targets };
  });
