import { z } from "zod";
import { authRequired } from "./middleware.js";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import * as label from "@rw/services/label/index";
import { throwServiceError, unwrap } from "./errors.js";

// The site's shared list of labels. Only admins manage the list itself:
// create/update/delete need settings:write. Putting an existing label ON a
// record only needs permission to edit that record (job:write etc.), so
// office users can tag things but can't invent or rename labels.

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  q: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "settings:write", scope: { kind: "site", siteId: input.siteId } }));

  return unwrap(await label.create(input));
});

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(await authorizeList(context.iam, { permission: "facility:read", requestedSiteId: input.siteId }));

  return label.list({ ...input, ...scopeFilter(scope) });
});

export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "facility:read", scope: { kind: "label", id: input.id } }));

  return unwrap(await label.getById(input.id), { notFoundMessage: "Label not found" });
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "settings:write", scope: { kind: "label", id: input.id } }));

  const { id, ...updateData } = input;
  return unwrap(await label.update(id, updateData));
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "settings:write", scope: { kind: "label", id: input.id } }));

  const result = await label.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});
