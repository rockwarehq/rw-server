// Bucket administration: the whole sharing surface of the access model.
// "Which buckets am I in", "who is in this bucket", and access grants.

import prisma from "@rw/db";
import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { describeAccess, staffLabel } from "@rw/auth/iam/access";
import { workspace as workspaceService } from "../services/account/index.js";
import { userRequired } from "./middleware.js";

const tierSchema = z.enum(["VIEW", "MANAGE", "ADMIN"]);

/** My buckets — the "plants and cells I'm in" screen. */
export const list = userRequired.handler(async ({ context }) => {
  const person = context.access.person;
  const entries = await describeAccess(person);
  return {
    owner: person.owner,
    staff: staffLabel(person),
    buckets: entries.map(({ bucketId, ...entry }) => ({ id: bucketId, ...entry })),
  };
});

const membersInputSchema = z.object({ bucketId: z.uuid() });

/** Who's in this bucket — reserved: plant ADMIN at the bucket's site. */
export const members = userRequired.input(membersInputSchema).handler(async ({ input, context }) => {
  const target = await prisma.bucket.findUnique({
    where: { id: input.bucketId },
    select: { siteId: true },
  });
  if (!target?.siteId) throw new ORPCError("NOT_FOUND", { message: "Bucket not found" });
  await context.access.require("ADMIN", { site: target.siteId });

  const accesses = await prisma.bucketAccess.findMany({
    where: { bucketId: input.bucketId },
    select: {
      tier: true,
      membership: {
        select: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      },
    },
  });
  return { members: accesses.map((a) => ({ tier: a.tier, user: a.membership.user })) };
});

const setAccessInputSchema = z.object({
  userId: z.uuid(),
  bucketId: z.uuid(),
  tier: tierSchema,
});

/** Grant or change one member's access to one bucket. */
export const setAccess = userRequired.input(setAccessInputSchema).handler(async ({ input, context }) => {
  const result = await workspaceService.updateAccess({
    workspaceId: context.current.workspaceId,
    actor: context.access,
    targetUserId: input.userId,
    set: [{ bucketId: input.bucketId, tier: input.tier }],
  });
  if (!result.success) {
    const status =
      result.code === "FORBIDDEN" ? "FORBIDDEN" : result.code === "MEMBER_NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST";
    throw new ORPCError(status, { message: result.error });
  }
  return { access: result.access };
});

const removeAccessInputSchema = z.object({
  userId: z.uuid(),
  bucketId: z.uuid(),
});

/** Remove one member's access to one bucket. */
export const removeAccess = userRequired.input(removeAccessInputSchema).handler(async ({ input, context }) => {
  const result = await workspaceService.updateAccess({
    workspaceId: context.current.workspaceId,
    actor: context.access,
    targetUserId: input.userId,
    remove: [input.bucketId],
  });
  if (!result.success) {
    const status =
      result.code === "FORBIDDEN" ? "FORBIDDEN" : result.code === "MEMBER_NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST";
    throw new ORPCError(status, { message: result.error });
  }
  return { access: result.access };
});
