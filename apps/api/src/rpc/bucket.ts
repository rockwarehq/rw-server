// Bucket administration: the whole sharing surface of the access model.
// "Which buckets am I in", "who is in this bucket", and access grants.

import prisma from "@rw/db";
import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authorize } from "@rw/auth/iam/policy";
import { workspace as workspaceService } from "../services/account/index.js";
import { authRequired } from "./middleware.js";
import { grant } from "./authz.js";

const tierSchema = z.enum(["VIEW", "MANAGE", "ADMIN"]);

/** My buckets — the "plants and cells I'm in" screen. */
export const list = authRequired.handler(async ({ context }) => {
  const iam = context.iam;
  if (!iam.workspaceId || !iam.id) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }
  const snapshot = iam.bucketSnapshot;
  if (!snapshot) return { owner: false, staff: "NONE", buckets: [] };
  if (snapshot.owner || snapshot.staff !== "NONE") {
    return { owner: snapshot.owner, staff: snapshot.staff, buckets: [] };
  }
  const buckets = await prisma.bucket.findMany({
    where: { id: { in: snapshot.entries.map((e) => e.bucketId) } },
    select: { id: true, name: true, kind: true, siteId: true, workcenterId: true },
  });
  const byId = new Map(buckets.map((b) => [b.id, b]));
  return {
    owner: false,
    staff: "NONE",
    buckets: snapshot.entries
      .map((e) => {
        const bucket = byId.get(e.bucketId);
        return bucket ? { ...bucket, tier: e.tier, via: e.via } : null;
      })
      .filter((b) => b !== null),
  };
});

const membersInputSchema = z.object({ bucketId: z.uuid() });

/** Who's in this bucket — reserved: plant ADMIN at the bucket's site. */
export const members = authRequired.input(membersInputSchema).handler(async ({ input, context }) => {
  const target = await prisma.bucket.findUnique({
    where: { id: input.bucketId },
    select: { siteId: true },
  });
  if (!target?.siteId) throw new ORPCError("NOT_FOUND", { message: "Bucket not found" });
  grant(await authorize(context.iam, { tier: "ADMIN", scope: { kind: "site", siteId: target.siteId } }));

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
export const setAccess = authRequired.input(setAccessInputSchema).handler(async ({ input, context }) => {
  const iam = context.iam;
  if (!iam.workspaceId || !iam.id) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }
  const result = await workspaceService.updateAccess({
    workspaceId: iam.workspaceId,
    actorUserId: iam.id,
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
export const removeAccess = authRequired.input(removeAccessInputSchema).handler(async ({ input, context }) => {
  const iam = context.iam;
  if (!iam.workspaceId || !iam.id) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }
  const result = await workspaceService.updateAccess({
    workspaceId: iam.workspaceId,
    actorUserId: iam.id,
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
