import { z } from "zod";
import { userRequired } from "./middleware.js";
import * as notification from "@rw/services/notification/index";
import { throwServiceError, unwrap } from "./errors.js";

const channelSchema = z.enum(["EMAIL", "SMS"]);
const memberIdsSchema = z.array(z.uuid()).max(500);
const idInputSchema = z.object({ id: z.uuid() });
const pageSchema = { limit: z.number().min(0).default(50), offset: z.number().min(0).default(0) };

const groupCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  channels: z.array(channelSchema).min(1).optional(),
  memberIds: memberIdsSchema.optional(),
});

const groupUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  channels: z.array(channelSchema).min(1).optional(),
  // Whole-list replacement.
  memberIds: memberIdsSchema.optional(),
});

const groupListInputSchema = z.object({
  siteId: z.uuid().optional(),
  includeArchived: z.boolean().default(false),
  ...pageSchema,
});

const sendInputSchema = z
  .object({
    siteId: z.uuid(),
    groupIds: z.array(z.uuid()).max(50).optional(),
    employeeIds: z.array(z.uuid()).max(500).optional(),
    // Groups bring their own channels; this is how directly-listed people get one.
    channels: z.array(channelSchema).min(1).optional(),
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(10_000),
  })
  .refine((v) => (v.groupIds?.length ?? 0) + (v.employeeIds?.length ?? 0) > 0, {
    message: "Pick at least one group or person",
  });

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  groupId: z.uuid().optional(),
  ...pageSchema,
});

// ── Groups ───────────────────────────────────────────────────────────────

export const groupCreate = userRequired.input(groupCreateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  const result = await notification.createGroup(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const groupList = userRequired.input(groupListInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);
  return notification.listGroups({ ...input, siteId: scope.siteId });
});

export const groupGet = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { notificationGroup: input.id });
  return unwrap(await notification.getGroupById(input.id), { notFoundMessage: "Notification group not found" });
});

export const groupUpdate = userRequired.input(groupUpdateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { notificationGroup: input.id });

  const { id, ...data } = input;
  const result = await notification.updateGroup(id, data);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const groupArchive = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { notificationGroup: input.id });

  const result = await notification.archiveGroup(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

// ── Sending + delivery log ───────────────────────────────────────────────

/** A person sending to groups and/or people from the UI (a test send or an ad-hoc message). */
export const send = userRequired.input(sendInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  const result = await notification.send({
    ...input,
    source: "MANUAL",
    sourceType: "user",
    sourceRef: context.current.user.id,
  });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);
  return notification.list({ ...input, siteId: scope.siteId });
});

export const get = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { notification: input.id });
  return unwrap(await notification.getById(input.id), { notFoundMessage: "Notification not found" });
});
