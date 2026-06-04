import { z } from "zod";
import { ORPCError } from "@orpc/server";
import type { DocumentTargetType } from "@rw/db";
import * as documents from "@rw/services/document/index";
import { storageConfig } from "../config.js";
import { Principal } from "../services/auth/index.js";
import { authRequired, displayRequired, userOrDisplayRequired } from "./middleware.js";

const documentTargetTypeSchema = z.enum(["SITE", "WORKCENTER", "STATION", "JOB", "TOOL", "PRODUCT", "MATERIAL"]);

const attrsSchema = z.record(z.string(), z.unknown());
const labelsSchema = z.array(z.string().min(1).max(80)).max(50);

const documentIdInputSchema = z.object({
  documentId: z.uuid(),
});

const createFolderInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  labels: labelsSchema.optional(),
  siteId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  attrs: attrsSchema.optional(),
});

const createUploadInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  labels: labelsSchema.optional(),
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
  siteId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  attrs: attrsSchema.optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  kind: z.enum(["FILE", "FOLDER"]).optional(),
  includePending: z.boolean().default(false),
  labelsAny: labelsSchema.optional(),
  labelsAll: labelsSchema.optional(),
  q: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
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

const displayContextInputSchema = z
  .object({
    labelsAny: labelsSchema.optional(),
    labelsAll: labelsSchema.optional(),
  })
  .optional();

function getLabelFilter(input?: { labelsAny?: string[]; labelsAll?: string[] }) {
  return {
    labelsAny: input?.labelsAny,
    labelsAll: input?.labelsAll,
  };
}

function throwDocumentError(result: { error?: unknown; code?: unknown }): never {
  const code = result.code as string;
  const message = result.error as string;

  if (
    ["DOCUMENT_NOT_FOUND", "PARENT_NOT_FOUND", "SITE_NOT_FOUND", "TARGET_NOT_FOUND", "UPLOAD_NOT_FOUND"].includes(code)
  ) {
    throw new ORPCError("NOT_FOUND", { message, cause: result });
  }

  if (["SITE_NOT_IN_WORKSPACE"].includes(code)) {
    throw new ORPCError("FORBIDDEN", { message, cause: result });
  }

  if (["SITE_MISMATCH", "DOCUMENT_PENDING", "INVALID_PARENT"].includes(code)) {
    throw new ORPCError("CONFLICT", { message, cause: result });
  }

  throw new ORPCError("BAD_REQUEST", { message, cause: result });
}

function getDisplayDocumentContext(context: {
  iam: { siteId?: string; display?: { workcenterId: string | null; stationId: string | null } };
}) {
  if (!context.iam.siteId) {
    throw new ORPCError("BAD_REQUEST", { message: "Display site context required" });
  }

  return {
    siteId: context.iam.siteId,
    workcenterId: context.iam.display?.workcenterId ?? null,
    stationId: context.iam.display?.stationId ?? null,
  };
}

async function assertDisplayCanAccessDocument(
  context: { iam: { siteId?: string; display?: { workcenterId: string | null; stationId: string | null } } },
  documentId: string,
) {
  const result = await documents.listForDisplayContext(getDisplayDocumentContext(context));
  if (!result.data.some((document) => document.id === documentId)) {
    throw new ORPCError("NOT_FOUND", { message: "Document not found" });
  }
}

export const createFolder = authRequired.input(createFolderInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await documents.createFolder({ ...input, workspaceId });
  if ("error" in result) throwDocumentError(result);
  return result.data;
});

export const createUpload = authRequired.input(createUploadInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await documents.createUpload({ ...input, workspaceId });
  if ("error" in result) throwDocumentError(result);
  return result.data;
});

export const completeUpload = authRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await documents.completeUpload(input.documentId);
  if ("error" in result) throwDocumentError(result);
  return result.data;
});

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return documents.list(input);
});

export const get = userOrDisplayRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  if (context.iam.principal === Principal.DISPLAY) {
    await assertDisplayCanAccessDocument(context, input.documentId);
    const result = await documents.getById(input.documentId);
    if (!result) throw new ORPCError("NOT_FOUND", { message: "Document not found" });
    if ("error" in result) throwDocumentError(result);
    return result.data;
  }

  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await documents.getById(input.documentId, { includePending: true });
  if (!result) throw new ORPCError("NOT_FOUND", { message: "Document not found" });
  if ("error" in result) throwDocumentError(result);
  return result.data;
});

export const download = userOrDisplayRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  if (context.iam.principal === Principal.DISPLAY) {
    await assertDisplayCanAccessDocument(context, input.documentId);
  } else {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }
  }

  const result = await documents.getDownloadUrl(input.documentId);
  if ("error" in result) throwDocumentError(result);
  return result.data;
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const { documentId, ...updateData } = input;
  const result = await documents.update(documentId, updateData);
  if ("error" in result) throwDocumentError(result);
  return result.data;
});

export const remove = authRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await documents.remove(input.documentId);
  if ("error" in result) throwDocumentError(result);
  return { success: true };
});

export const link = authRequired.input(documentLinkInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await documents.link(input.documentId, input.targetType as DocumentTargetType, input.targetId);
  if ("error" in result) throwDocumentError(result);
  return result.data;
});

export const unlink = authRequired.input(documentLinkInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return documents.unlink(input.documentId, input.targetType as DocumentTargetType, input.targetId);
});

export const listForTarget = authRequired.input(targetInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return documents.listForTarget(input.targetType as DocumentTargetType, input.targetId, getLabelFilter(input));
});

export const listForDisplayContext = displayRequired
  .input(displayContextInputSchema)
  .handler(async ({ input, context }) => {
    return documents.listForDisplayContext(getDisplayDocumentContext(context), getLabelFilter(input));
  });
