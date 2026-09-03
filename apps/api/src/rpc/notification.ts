import { z } from "zod";
import { authRequired } from "./middleware.js";
import { authorize, authorizeList } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
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

export const groupCreate = authRequired.input(groupCreateInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "notifications:admin", scope: { kind: "site", siteId: input.siteId } }),
  );

  const result = await notification.createGroup(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const groupList = authRequired.input(groupListInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorizeList(context.iam, { permission: "notifications:read", requestedSiteId: input.siteId }),
  );
  return notification.listGroups({ ...input, siteId: scope.siteId });
});

export const groupGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, {
      permission: "notifications:read",
      scope: { kind: "notificationGroup", id: input.id },
    }),
  );
  return unwrap(await notification.getGroupById(input.id), { notFoundMessage: "Notification group not found" });
});

export const groupUpdate = authRequired.input(groupUpdateInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, {
      permission: "notifications:admin",
      scope: { kind: "notificationGroup", id: input.id },
    }),
  );

  const { id, ...data } = input;
  const result = await notification.updateGroup(id, data);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const groupArchive = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, {
      permission: "notifications:admin",
      scope: { kind: "notificationGroup", id: input.id },
    }),
  );

  const result = await notification.archiveGroup(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

// ── Sending + delivery log ───────────────────────────────────────────────

/** A person sending to groups and/or people from the UI (a test send or an ad-hoc message). */
export const send = authRequired.input(sendInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "notifications:write", scope: { kind: "site", siteId: input.siteId } }),
  );

  const result = await notification.send({ ...input, source: "MANUAL", sourceType: "user", sourceRef: context.iam.id });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorizeList(context.iam, { permission: "notifications:read", requestedSiteId: input.siteId }),
  );
  return notification.list({ ...input, siteId: scope.siteId });
});

export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "notifications:read", scope: { kind: "notification", id: input.id } }),
  );
  return unwrap(await notification.getById(input.id), { notFoundMessage: "Notification not found" });
});
