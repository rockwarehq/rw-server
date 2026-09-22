import { z } from "zod";
import { ORPCError } from "@orpc/server";
import type { DocumentTargetType } from "@rw/db";
import * as documents from "@rw/services/document/index";
import {
  authorizeDocument,
  authorizeDocumentTarget,
  authorizeDocumentTree,
  readableDocumentIds,
} from "@rw/services/document/access-scope";
import type { IAMContext } from "@rw/auth/context";
import { storageConfig } from "../config.js";
import { Principal } from "../auth/index.js";
import { authRequired, displayRequired, userOrDisplayRequired } from "./middleware.js";
import { authorize, authorizeReferenceRead } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { throwServiceError } from "./errors.js";

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
  const { workspaceId, siteId } = await authorizeCreate(context.iam, input);

  const result = await documents.createFolder({ ...input, siteId: siteId ?? null, workspaceId });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const createUpload = authRequired.input(createUploadInputSchema).handler(async ({ input, context }) => {
  const { workspaceId, siteId } = await authorizeCreate(context.iam, input);

  const result = await documents.createUpload({ ...input, siteId: siteId ?? null, workspaceId });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const completeUpload = authRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  grant(await authorizeDocument(context.iam, input.documentId, true));

  const result = await documents.completeUpload(input.documentId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const siteId = input.siteId === undefined ? context.iam.siteId : input.siteId;
  if (siteId === undefined) throw new ORPCError("BAD_REQUEST", { message: "Site context required" });
  grant(
    siteId === null
      ? await authorize(context.iam, { permission: "configuration:read", scope: { kind: "workspace" } })
      : await authorizeReferenceRead(context.iam, { scope: { kind: "site", siteId } }),
  );
  if (input.parentId) assertDocumentSite(grant(await authorizeDocument(context.iam, input.parentId)), siteId);
  if (input.linkedTo) assertDocumentSite(grant(await authorizeDocumentTarget(context.iam, input.linkedTo)), siteId);
  return documents.list({ ...input, siteId }, { siteId, documentIds: await readableDocumentIds(context.iam, siteId) });
});

export const get = userOrDisplayRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  if (context.iam.principal === Principal.DISPLAY) {
    await assertDisplayCanAccessDocument(context, input.documentId);
    const result = await documents.getById(input.documentId);
    if (!result) throw new ORPCError("NOT_FOUND", { message: "Document not found" });
    if (result.error !== undefined) throwServiceError(result);
    return result.data;
  }

  grant(await authorizeDocument(context.iam, input.documentId));

  const result = await documents.getById(input.documentId, { includePending: true });
  if (!result) throw new ORPCError("NOT_FOUND", { message: "Document not found" });
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const download = userOrDisplayRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  if (context.iam.principal === Principal.DISPLAY) {
    await assertDisplayCanAccessDocument(context, input.documentId);
  } else {
    grant(await authorizeDocument(context.iam, input.documentId));
  }

  const result = await documents.getDownloadUrl(input.documentId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const open = userOrDisplayRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  if (context.iam.principal === Principal.DISPLAY) {
    await assertDisplayCanAccessDocument(context, input.documentId);
  } else {
    grant(await authorizeDocument(context.iam, input.documentId));
  }

  const result = await documents.getOpenUrl(input.documentId);
  if (result.error !== undefined) throwServiceError(result);
  return result.data;
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeDocumentTree(context.iam, input.documentId));
  if (input.parentId)
    assertDocumentSite(grant(await authorizeDocument(context.iam, input.parentId, true)), scope.siteId ?? null);
  if (input.parentId === null) {
    grant(
      await authorize(context.iam, {
        permission: "configuration:write",
        scope: scope.siteId ? { kind: "site", siteId: scope.siteId } : { kind: "workspace" },
      }),
    );
  }

  const { documentId, ...updateData } = input;
  const result = await documents.update(documentId, updateData);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const remove = authRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  grant(await authorizeDocumentTree(context.iam, input.documentId));

  const result = await documents.remove(input.documentId);
  if (result.error !== undefined) throwServiceError(result);
  return { success: true };
});

export const link = authRequired.input(documentLinkInputSchema).handler(async ({ input, context }) => {
  grant(await authorizeDocumentTree(context.iam, input.documentId));
  grant(await authorizeDocumentTarget(context.iam, input, true));

  const result = await documents.link(input.documentId, input.targetType as DocumentTargetType, input.targetId);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const unlink = authRequired.input(documentLinkInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeDocumentTree(context.iam, input.documentId));
  grant(await authorizeDocumentTarget(context.iam, input, true));
  // Removing the last target can broaden a document to plant-shared visibility.
  grant(
    await authorize(context.iam, {
      permission: "configuration:write",
      scope: scope.siteId ? { kind: "site", siteId: scope.siteId } : { kind: "workspace" },
    }),
  );

  return documents.unlink(input.documentId, input.targetType as DocumentTargetType, input.targetId);
});

export const listForTarget = authRequired.input(targetInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeDocumentTarget(context.iam, input));
  const result = await documents.listForTarget(
    input.targetType as DocumentTargetType,
    input.targetId,
    getLabelFilter(input),
  );
  const data = [];
  for (const document of result.data) {
    if (document.siteId !== null && document.siteId !== scope.siteId) continue;
    if ((await authorizeDocument(context.iam, document.id)).ok) data.push(document);
  }
  return { data };
});

export const listForDisplayContext = displayRequired
  .input(displayContextInputSchema)
  .handler(async ({ input, context }) => {
    return documents.listForDisplayContext(getDisplayDocumentContext(context), getLabelFilter(input));
  });

function assertDocumentSite(scope: { siteId?: string }, siteId: string | null) {
  if ((scope.siteId ?? null) !== siteId) throw new ORPCError("FORBIDDEN", { message: "Document scope mismatch" });
}

async function authorizeCreate(iam: IAMContext, input: { siteId?: string | null; parentId?: string | null }) {
  if (input.parentId) {
    const parent = grant(await authorizeDocument(iam, input.parentId, true));
    if (input.siteId !== undefined) assertDocumentSite(parent, input.siteId);
    return parent;
  }
  const siteId = input.siteId === undefined ? iam.siteId : input.siteId;
  if (siteId === undefined) throw new ORPCError("BAD_REQUEST", { message: "Site context required" });
  return grant(
    await authorize(iam, {
      permission: "configuration:write",
      scope: siteId ? { kind: "site", siteId } : { kind: "workspace" },
    }),
  );
}
