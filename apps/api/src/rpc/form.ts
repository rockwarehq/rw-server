import { z } from "zod";
import { ORPCError } from "@orpc/server";
import * as forms from "@rw/services/form/index";
import { userRequired } from "./middleware.js";
import { unwrap } from "./errors.js";

// Forms are FORM documents with versioned content (see services/form). Rename,
// description, labels and delete go through document.update / document.delete.

const labelsSchema = z.array(z.string().min(1).max(80)).max(50);

const documentIdInputSchema = z.object({
  documentId: z.uuid(),
});

const listInputSchema = z.object({
  siteId: z.uuid().nullable().optional(),
  q: z.string().max(200).optional(),
  limit: z.number().int().min(0).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

const createInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  siteId: z.uuid().nullable().optional(),
  labels: labelsSchema.optional(),
});

/** The editor document (TipTap JSON); its size is checked by the service. */
const saveDraftInputSchema = documentIdInputSchema.extend({
  content: z.record(z.string(), z.unknown()),
});

const publishInputSchema = documentIdInputSchema.extend({
  note: z.string().max(2000).nullable().optional(),
});

const submitInputSchema = documentIdInputSchema.extend({
  /** The published version that was filled; must still be the current one. */
  formId: z.uuid(),
  answers: z.record(z.string(), z.unknown()),
  stationId: z.uuid().nullable().optional(),
});

const listSubmissionsInputSchema = documentIdInputSchema.extend({
  stationId: z.uuid().nullable().optional(),
  limit: z.number().int().min(0).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

const fillContextInputSchema = z.object({
  stationId: z.uuid(),
});

const scrapReasonsInputSchema = z.object({
  siteId: z.uuid(),
});

const submissionIdInputSchema = z.object({
  submissionId: z.uuid(),
});

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  if (input.siteId) await context.access.require("VIEW", { site: input.siteId });
  else context.access.requireSomewhere("VIEW");

  return unwrap(await forms.list(input));
});

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  if (input.siteId) await context.access.require("MANAGE", { site: input.siteId });
  else context.access.requireSomewhere("MANAGE");

  const result = await forms.create({
    ...input,
    workspaceId: context.current.workspaceId,
    createdById: context.current.user.id,
  });
  return unwrap(result);
});

export const get = userRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { document: input.documentId });

  const result = await forms.get(input.documentId);
  return unwrap(result);
});

export const saveDraft = userRequired.input(saveDraftInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const result = await forms.saveDraft(input.documentId, input.content, context.current.user.id);
  return unwrap(result);
});

export const publish = userRequired.input(publishInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const result = await forms.publish(input.documentId, { note: input.note, userId: context.current.user.id });
  return unwrap(result);
});

export const discardDraft = userRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { document: input.documentId });

  const result = await forms.discardDraft(input.documentId);
  return unwrap(result);
});

export const listVersions = userRequired.input(documentIdInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { document: input.documentId });

  const result = await forms.listVersions(input.documentId);
  return unwrap(result);
});

export const submit = userRequired.input(submitInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { document: input.documentId });
  if (input.stationId) await context.access.require("VIEW", { station: input.stationId });

  const result = await forms.submit({ ...input, submittedById: context.current.user.id });
  return unwrap(result);
});

export const listSubmissions = userRequired.input(listSubmissionsInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { document: input.documentId });

  const result = await forms.listSubmissions(input);
  return unwrap(result);
});

export const getSubmission = userRequired.input(submissionIdInputSchema).handler(async ({ input, context }) => {
  const documentId = await forms.submissionDocumentId(input.submissionId);
  if (!documentId) throw new ORPCError("NOT_FOUND", { message: "Submission not found" });
  await context.access.require("VIEW", { document: documentId });

  const result = await forms.getSubmission(input.submissionId);
  return unwrap(result);
});

/** What filling a form at a station needs: its job and parts, running shift and scrap reasons. */
export const fillContext = userRequired.input(fillContextInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { station: input.stationId });

  const result = await forms.fillContext(input.stationId);
  return unwrap(result);
});

/** The scrap reasons a form's editor offers for scrap a calculation works out. */
export const scrapReasons = userRequired.input(scrapReasonsInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });

  const result = await forms.scrapReasons(input.siteId);
  return unwrap(result);
});
