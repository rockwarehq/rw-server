// ─── SPIKE: bucket administration surface ────────────────────────────────
// The entire access-management UX of the bucket model fits in two
// procedures: "which buckets am I in" and "who is in this bucket". Compare
// with roles + assignments + workcenter grants + /users/me expansion.

import prisma from "@rw/db";
import { z } from "zod";
import { authorizeBucketTier, loadBucketSnapshot } from "@rw/auth/iam/buckets";
import { authRequired } from "./middleware.js";
import { grant } from "./authz.js";
import { ORPCError } from "@orpc/server";

/** My buckets — the Basecamp "projects I'm on" screen. */
export const list = authRequired.handler(async ({ context }) => {
  const iam = context.iam;
  if (!iam.workspaceId || !iam.id) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }
  const snapshot = await loadBucketSnapshot(iam.id, iam.workspaceId);
  if (!snapshot) return { admin: false, buckets: [] };
  if (snapshot.admin) return { admin: true, buckets: [] };

  const buckets = await prisma.bucket.findMany({
    where: { id: { in: snapshot.entries.map((e) => e.bucketId) } },
    select: { id: true, name: true, kind: true, siteId: true, workcenterId: true },
  });
  const tierByBucket = new Map(snapshot.entries.map((e) => [e.bucketId, e.tier]));
  return {
    admin: false,
    buckets: buckets.map((b) => ({ ...b, tier: tierByBucket.get(b.id) ?? "VIEW" })),
  };
});

const membersInputSchema = z.object({ bucketId: z.uuid() });

/** Who's in this bucket — the whole sharing/roster UI in one query. */
export const members = authRequired.input(membersInputSchema).handler(async ({ input, context }) => {
  grant(await authorizeBucketTier(context.iam, { ref: { kind: "bucket", bucketId: input.bucketId }, tier: "MANAGE" }));

  const accesses = await prisma.bucketAccess.findMany({
    where: { bucketId: input.bucketId },
    select: { tier: true, membershipId: true },
  });
  const memberships = await prisma.workspaceMembership.findMany({
    where: { id: { in: accesses.map((a) => a.membershipId) } },
    select: { id: true, user: { select: { id: true, email: true, firstName: true, lastName: true } } },
  });
  const byMembership = new Map(memberships.map((m) => [m.id, m.user]));
  return {
    members: accesses.map((a) => ({ tier: a.tier, user: byMembership.get(a.membershipId) ?? null })),
  };
});
