import { z } from "zod";
import { userRequired } from "./middleware.js";
import * as label from "@rw/services/label/index";
import { throwServiceError, unwrap } from "./errors.js";

// The site's shared list of labels. Only admins manage the list itself:
// create/update/delete are plant MANAGE. Putting an existing label ON a
// record only needs the access to edit that record., so
// office users can tag things but can't invent or rename labels.

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1).max(80),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
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

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  return unwrap(await label.create(input));
});

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);

  return label.list({ ...input, siteId: scope.siteId });
});

export const get = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { label: input.id });

  return unwrap(await label.getById(input.id), { notFoundMessage: "Label not found" });
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { label: input.id });

  const { id, ...updateData } = input;
  return unwrap(await label.update(id, updateData));
});

export const remove = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { label: input.id });

  const result = await label.remove(input.id);
  if (result.error) throwServiceError(result);
  return { success: true };
});
