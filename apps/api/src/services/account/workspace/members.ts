import prisma from "@rw/db";
import {
  type BucketSnapshot,
  type BucketTier,
  loadBucketSnapshot,
  snapshotPlantTier,
  TIER_RANK,
  tierAtLeast,
} from "@rw/auth/iam/index";

// Workspace member management over the bucket model. A member's access is
// their workspaceRole (OWNER is reserved ownership) plus their bucket
// accesses; there is nothing else to administer.

export type MemberBucketAccess = {
  bucketId: string;
  kind: "PLANT" | "WORKCENTER";
  siteId: string | null;
  workcenterId: string | null;
  name: string;
  tier: BucketTier;
};

export type MemberAccessSummary = {
  workspaceRole: "OWNER" | "MEMBER";
  buckets: MemberBucketAccess[];
  /** Sites where the member holds any bucket — what the member UI shows. */
  siteIds: string[];
};

const ACCESS_SELECT = {
  tier: true,
  bucket: { select: { id: true, kind: true, siteId: true, workcenterId: true, name: true } },
} as const;

type AccessRow = {
  tier: string;
  bucket: { id: string; kind: string; siteId: string | null; workcenterId: string | null; name: string };
};

function summarize(workspaceRole: string, accesses: AccessRow[]): MemberAccessSummary {
  const buckets = accesses.map((a) => ({
    bucketId: a.bucket.id,
    kind: a.bucket.kind as "PLANT" | "WORKCENTER",
    siteId: a.bucket.siteId,
    workcenterId: a.bucket.workcenterId,
    name: a.bucket.name,
    tier: a.tier as BucketTier,
  }));
  return {
    workspaceRole: workspaceRole as "OWNER" | "MEMBER",
    buckets,
    siteIds: [...new Set(buckets.map((b) => b.siteId).filter((s): s is string => s !== null))],
  };
}

/** Per-user access summaries for a set of users (member list, /users). */
export async function getWorkspaceAccessSummaries(
  workspaceId: string,
  userIds: string[],
): Promise<Map<string, MemberAccessSummary>> {
  if (userIds.length === 0) return new Map();
  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId, userId: { in: userIds } },
    select: { userId: true, workspaceRole: true, bucketAccesses: { select: ACCESS_SELECT } },
  });
  return new Map(memberships.map((m) => [m.userId, summarize(m.workspaceRole, m.bucketAccesses)]));
}

export async function listMembers(workspaceId: string) {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId },
    select: {
      id: true,
      joinedAt: true,
      workspaceRole: true,
      employeeId: true,
      user: { select: { id: true, email: true, firstName: true, lastName: true, status: true } },
      bucketAccesses: { select: ACCESS_SELECT },
    },
    orderBy: { joinedAt: "asc" },
  });
  return memberships.map((m) => ({
    membershipId: m.id,
    joinedAt: m.joinedAt,
    employeeId: m.employeeId,
    user: m.user,
    access: summarize(m.workspaceRole, m.bucketAccesses),
  }));
}

// ── Guards ───────────────────────────────────────────────────────────────

function actorAdminAt(snapshot: BucketSnapshot, siteId: string | null): boolean {
  if (snapshot.owner || snapshot.staff === "FULL") return true;
  if (!siteId) return false;
  return tierAtLeast(snapshotPlantTier(snapshot, siteId), "ADMIN");
}

/**
 * A plant must keep at least one member with ADMIN on its plant bucket so
 * the site stays self-administrable without owner intervention.
 */
async function wouldRemoveLastPlantAdmin(bucketId: string, membershipId: string): Promise<boolean> {
  const bucket = await prisma.bucket.findUnique({ where: { id: bucketId }, select: { kind: true } });
  if (bucket?.kind !== "PLANT") return false;
  const remaining = await prisma.bucketAccess.count({
    where: { bucketId, tier: "ADMIN", membershipId: { not: membershipId } },
  });
  return remaining === 0;
}

async function isLastOwner(workspaceId: string, membershipId: string): Promise<boolean> {
  const otherOwners = await prisma.workspaceMembership.count({
    where: { workspaceId, workspaceRole: "OWNER", id: { not: membershipId } },
  });
  return otherOwners === 0;
}

// ── Mutations ────────────────────────────────────────────────────────────

export type UpdateAccessErrorCode =
  | "MEMBER_NOT_FOUND"
  | "BUCKET_NOT_FOUND"
  | "INVALID_TIER"
  | "FORBIDDEN"
  | "LAST_OWNER"
  | "LAST_PLANT_ADMIN";

export interface UpdateAccessInput {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  /** Upsert these accesses. */
  set?: Array<{ bucketId: string; tier: BucketTier }>;
  /** Remove access to these buckets. */
  remove?: string[];
  /** Change the member's workspace role — owners only, last-owner guarded. */
  workspaceRole?: "OWNER" | "MEMBER";
}

export type UpdateAccessResult =
  | { success: true; access: MemberAccessSummary }
  | { success: false; code: UpdateAccessErrorCode; error: string };

export async function updateAccess(input: UpdateAccessInput): Promise<UpdateAccessResult> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: input.targetUserId, workspaceId: input.workspaceId } },
    select: { id: true, workspaceRole: true },
  });
  if (!membership) return { success: false, code: "MEMBER_NOT_FOUND", error: "Member not found" };

  const snapshot = await loadBucketSnapshot(input.actorUserId, input.workspaceId);
  if (!snapshot) return { success: false, code: "FORBIDDEN", error: "Forbidden" };

  const set = input.set ?? [];
  const remove = input.remove ?? [];

  // Ownership changes are the owner's alone.
  if (input.workspaceRole && !snapshot.owner) {
    return { success: false, code: "FORBIDDEN", error: "Ownership changes are reserved for the workspace owner" };
  }
  if (input.workspaceRole === "MEMBER" && membership.workspaceRole === "OWNER") {
    if (await isLastOwner(input.workspaceId, membership.id)) {
      return { success: false, code: "LAST_OWNER", error: "Cannot remove the last workspace owner" };
    }
  }

  // Validate buckets and the actor's authority at each touched site.
  const touched = [...set.map((s) => s.bucketId), ...remove];
  const buckets = await prisma.bucket.findMany({
    where: { id: { in: touched } },
    select: { id: true, kind: true, siteId: true, workspaceId: true },
  });
  const byId = new Map(buckets.map((b) => [b.id, b]));
  for (const id of touched) {
    const bucket = byId.get(id);
    if (!bucket || bucket.workspaceId !== input.workspaceId) {
      return { success: false, code: "BUCKET_NOT_FOUND", error: "Bucket not found" };
    }
    if (!actorAdminAt(snapshot, bucket.siteId)) {
      return { success: false, code: "FORBIDDEN", error: "Requires ADMIN access at this plant" };
    }
  }
  for (const s of set) {
    const bucket = byId.get(s.bucketId);
    if (bucket?.kind === "WORKCENTER" && s.tier === "ADMIN") {
      return {
        success: false,
        code: "INVALID_TIER",
        error: "ADMIN is a plant tier; workcenter buckets go up to MANAGE",
      };
    }
    if (!TIER_RANK[s.tier]) {
      return { success: false, code: "INVALID_TIER", error: "Unknown tier" };
    }
  }

  // Last-plant-admin guard: removing or downgrading the final ADMIN access
  // on a plant bucket orphans the site.
  const existing = await prisma.bucketAccess.findMany({
    where: { membershipId: membership.id, bucketId: { in: touched } },
    select: { bucketId: true, tier: true },
  });
  const existingById = new Map(existing.map((e) => [e.bucketId, e.tier as BucketTier]));
  for (const id of touched) {
    const had = existingById.get(id);
    if (had !== "ADMIN") continue;
    const now = remove.includes(id) ? null : set.find((s) => s.bucketId === id)?.tier;
    if (now !== "ADMIN" && (await wouldRemoveLastPlantAdmin(id, membership.id))) {
      return { success: false, code: "LAST_PLANT_ADMIN", error: "Cannot remove the last plant admin" };
    }
  }

  await prisma.$transaction(async (tx) => {
    if (input.workspaceRole) {
      await tx.workspaceMembership.update({
        where: { id: membership.id },
        data: { workspaceRole: input.workspaceRole },
      });
    }
    for (const s of set) {
      await tx.bucketAccess.upsert({
        where: { bucketId_membershipId: { bucketId: s.bucketId, membershipId: membership.id } },
        update: { tier: s.tier },
        create: { bucketId: s.bucketId, membershipId: membership.id, tier: s.tier },
      });
    }
    if (remove.length) {
      await tx.bucketAccess.deleteMany({ where: { membershipId: membership.id, bucketId: { in: remove } } });
    }
  });

  const fresh = await prisma.workspaceMembership.findUniqueOrThrow({
    where: { id: membership.id },
    select: { workspaceRole: true, bucketAccesses: { select: ACCESS_SELECT } },
  });
  return { success: true, access: summarize(fresh.workspaceRole, fresh.bucketAccesses) };
}

export async function addMember(
  workspaceId: string,
  userId: string,
  accesses: Array<{ bucketId: string; tier: BucketTier }>,
) {
  const buckets = await prisma.bucket.findMany({
    where: { id: { in: accesses.map((a) => a.bucketId) } },
    select: { id: true, kind: true, workspaceId: true },
  });
  if (buckets.length !== new Set(accesses.map((a) => a.bucketId)).size) {
    throw new Error("Bucket not found");
  }
  for (const b of buckets) {
    if (b.workspaceId !== workspaceId) throw new Error("Bucket does not belong to this workspace");
  }
  for (const a of accesses) {
    if (buckets.find((b) => b.id === a.bucketId)?.kind === "WORKCENTER" && a.tier === "ADMIN") {
      throw new Error("ADMIN is a plant tier; workcenter buckets go up to MANAGE");
    }
  }
  return prisma.$transaction(async (tx) => {
    const membership = await tx.workspaceMembership.upsert({
      where: { userId_workspaceId: { userId, workspaceId } },
      update: {},
      create: { userId, workspaceId },
      select: { id: true },
    });
    for (const a of accesses) {
      await tx.bucketAccess.upsert({
        where: { bucketId_membershipId: { bucketId: a.bucketId, membershipId: membership.id } },
        update: { tier: a.tier },
        create: { bucketId: a.bucketId, membershipId: membership.id, tier: a.tier },
      });
    }
    return tx.workspaceMembership.findUniqueOrThrow({
      where: { id: membership.id },
      select: { id: true, workspaceRole: true, bucketAccesses: { select: ACCESS_SELECT } },
    });
  });
}

export async function removeMember(
  workspaceId: string,
  userId: string,
  context?: { actorId?: string; ipAddress?: string; userAgent?: string },
) {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true, workspaceRole: true },
  });
  if (!membership) {
    return { success: false as const, error: "MEMBER_NOT_FOUND" as const };
  }
  if (membership.workspaceRole === "OWNER" && (await isLastOwner(workspaceId, membership.id))) {
    return { success: false as const, error: "LAST_OWNER" as const };
  }

  await prisma.workspaceMembership.delete({ where: { id: membership.id } });
  void context;

  return { success: true as const };
}

/**
 * Remove a member's access at ONE site (all bucket accesses on that site's
 * buckets). A membership left with no accesses at all — and no ownership —
 * is removed entirely.
 */
export async function removeSiteAccess(
  workspaceId: string,
  userId: string,
  siteId: string,
  context?: { actorId?: string; ipAddress?: string; userAgent?: string },
) {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true, workspaceRole: true },
  });
  if (!membership) {
    return { success: false as const, error: "MEMBER_NOT_FOUND" as const };
  }

  // The site must keep one plant admin.
  const plantBucket = await prisma.bucket.findFirst({
    where: { siteId, kind: "PLANT" },
    select: { id: true },
  });
  if (plantBucket) {
    const targetAdmin = await prisma.bucketAccess.findFirst({
      where: { bucketId: plantBucket.id, membershipId: membership.id, tier: "ADMIN" },
      select: { id: true },
    });
    if (targetAdmin && (await wouldRemoveLastPlantAdmin(plantBucket.id, membership.id))) {
      return { success: false as const, error: "LAST_PLANT_ADMIN" as const };
    }
  }

  await prisma.bucketAccess.deleteMany({
    where: { membershipId: membership.id, bucket: { siteId } },
  });

  let membershipRemoved = false;
  if (membership.workspaceRole !== "OWNER") {
    const remaining = await prisma.bucketAccess.count({ where: { membershipId: membership.id } });
    if (remaining === 0) {
      await prisma.workspaceMembership.delete({ where: { id: membership.id } });
      membershipRemoved = true;
    }
  }

  void context;

  return { success: true as const, membershipRemoved };
}

// ── Reads used across the account surface ────────────────────────────────

export async function getUserWorkspaces(userId: string) {
  return prisma.workspaceMembership.findMany({
    where: { userId },
    select: {
      id: true,
      joinedAt: true,
      workspaceRole: true,
      workspace: { select: { id: true, name: true, slug: true } },
    },
  });
}

export async function getUserAccess(workspaceId: string, userId: string): Promise<MemberAccessSummary | null> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { workspaceRole: true, bucketAccesses: { select: ACCESS_SELECT } },
  });
  if (!membership) return null;
  return summarize(membership.workspaceRole, membership.bucketAccesses);
}

export async function isMember(workspaceId: string, userId: string): Promise<boolean> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });
  return membership !== null;
}

export async function countMembers(workspaceId: string): Promise<number> {
  return prisma.workspaceMembership.count({ where: { workspaceId } });
}
