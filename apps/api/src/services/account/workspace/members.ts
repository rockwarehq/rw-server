import prisma, { type Prisma } from "@rw/db";
import type { Level as BucketLevel, UserAccess } from "@rw/auth/iam/access";

// Member management over the bucket model. The account has one workspace,
// so a member is simply a user: their isAccountAdmin flag plus their
// bucket accesses. There is nothing else to administer.

export type MemberBucketAccess = {
  bucketId: string;
  kind: "PLANT" | "WORKCENTER";
  siteId: string | null;
  workcenterId: string | null;
  name: string;
  level: BucketLevel;
};

export type MemberAccessSummary = {
  isAccountAdmin: boolean;
  buckets: MemberBucketAccess[];
  /** Sites where the member holds any bucket — what the member UI shows. */
  siteIds: string[];
};

const ACCESS_SELECT = {
  level: true,
  bucket: { select: { id: true, kind: true, siteId: true, workcenterId: true, name: true } },
} as const;

type AccessRow = {
  level: string;
  bucket: { id: string; kind: string; siteId: string | null; workcenterId: string | null; name: string };
};

function summarize(isAccountAdmin: boolean, accesses: AccessRow[]): MemberAccessSummary {
  const buckets = accesses.map((a) => ({
    bucketId: a.bucket.id,
    kind: a.bucket.kind as "PLANT" | "WORKCENTER",
    siteId: a.bucket.siteId,
    workcenterId: a.bucket.workcenterId,
    name: a.bucket.name,
    level: a.level as BucketLevel,
  }));
  return {
    isAccountAdmin,
    buckets,
    siteIds: [...new Set(buckets.map((b) => b.siteId).filter((s): s is string => s !== null))],
  };
}

/**
 * Who counts as a member: every user except Rockware staff and people who
 * were removed (disabled with nothing left).
 */
const MEMBER_WHERE = {
  systemRole: null,
  NOT: { status: "DISABLED", isAccountAdmin: false, bucketAccesses: { none: {} } },
} satisfies Prisma.UserWhereInput;

export async function listMembers() {
  const users = await prisma.user.findMany({
    where: MEMBER_WHERE,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      createdAt: true,
      employeeId: true,
      isAccountAdmin: true,
      bucketAccesses: { select: ACCESS_SELECT },
    },
    orderBy: { createdAt: "asc" },
  });
  return users.map((u) => ({
    userId: u.id,
    createdAt: u.createdAt,
    employeeId: u.employeeId,
    user: { id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, status: u.status },
    access: summarize(u.isAccountAdmin, u.bucketAccesses),
  }));
}

// ── Shared by member management and invites ──────────────────────────────

/** ADMIN at the plant a bucket belongs to (account admins and ENGINEER staff pass). */
export function adminAt(actor: UserAccess, siteId: string | null): boolean {
  return siteId !== null && actor.can("ADMIN", { site: siteId });
}

export type BucketCheck =
  | { ok: true; buckets: Map<string, { kind: "PLANT" | "WORKCENTER"; siteId: string | null }> }
  | { ok: false; code: "BUCKET_NOT_FOUND" | "INVALID_LEVEL"; error: string };

/** The buckets exist, and ADMIN is only asked of plant buckets. One query. */
export async function checkBuckets(
  bucketIds: string[],
  levels: Array<{ bucketId: string; level: BucketLevel }> = [],
): Promise<BucketCheck> {
  const rows = await prisma.bucket.findMany({
    where: { id: { in: bucketIds } },
    select: { id: true, kind: true, siteId: true },
  });
  const buckets = new Map(rows.map((b) => [b.id, b]));
  if (bucketIds.some((id) => !buckets.has(id))) {
    return { ok: false, code: "BUCKET_NOT_FOUND", error: "Bucket not found" };
  }
  if (levels.some((t) => t.level === "ADMIN" && buckets.get(t.bucketId)?.kind === "WORKCENTER")) {
    return { ok: false, code: "INVALID_LEVEL", error: "ADMIN is a plant level; workcenter buckets go up to MANAGE" };
  }
  return { ok: true, buckets };
}

/** Upsert a user's accesses (inside the caller's transaction). */
export async function writeAccesses(
  tx: Prisma.TransactionClient,
  userId: string,
  accesses: Array<{ bucketId: string; level: BucketLevel }>,
) {
  for (const a of accesses) {
    await tx.bucketAccess.upsert({
      where: { bucketId_userId: { bucketId: a.bucketId, userId } },
      update: { level: a.level },
      create: { bucketId: a.bucketId, userId, level: a.level },
    });
  }
}

// ── Guards ───────────────────────────────────────────────────────────────

/**
 * A plant must keep at least one member with ADMIN on its plant bucket so
 * the site stays self-administrable without an account admin.
 */
async function wouldRemoveLastPlantAdmin(bucketId: string, userId: string): Promise<boolean> {
  const bucket = await prisma.bucket.findUnique({ where: { id: bucketId }, select: { kind: true } });
  if (bucket?.kind !== "PLANT") return false;
  const remaining = await prisma.bucketAccess.count({
    where: { bucketId, level: "ADMIN", userId: { not: userId } },
  });
  return remaining === 0;
}

/** The account must keep one account admin who can still sign in. */
async function isLastAccountAdmin(userId: string): Promise<boolean> {
  const others = await prisma.user.count({
    where: { isAccountAdmin: true, id: { not: userId }, status: { not: "DISABLED" } },
  });
  return others === 0;
}

/** A member of the account: any user who is not Rockware staff. */
async function findMember(userId: string) {
  return prisma.user.findFirst({
    where: { id: userId, systemRole: null },
    select: { id: true, isAccountAdmin: true },
  });
}

// ── Mutations ────────────────────────────────────────────────────────────

export type UpdateAccessErrorCode =
  | "MEMBER_NOT_FOUND"
  | "BUCKET_NOT_FOUND"
  | "INVALID_LEVEL"
  | "FORBIDDEN"
  | "LAST_ACCOUNT_ADMIN"
  | "LAST_PLANT_ADMIN";

export interface UpdateAccessInput {
  /** The caller's access; ADMIN is checked at each touched plant. */
  actor: UserAccess;
  targetUserId: string;
  /** Upsert these accesses. */
  set?: Array<{ bucketId: string; level: BucketLevel }>;
  /** Remove access to these buckets. */
  remove?: string[];
  /** Make or unmake an account admin — account admins only, last-admin guarded. */
  isAccountAdmin?: boolean;
}

export type UpdateAccessResult =
  | { success: true; access: MemberAccessSummary }
  | { success: false; code: UpdateAccessErrorCode; error: string };

export async function updateAccess(input: UpdateAccessInput): Promise<UpdateAccessResult> {
  const member = await findMember(input.targetUserId);
  if (!member) return { success: false, code: "MEMBER_NOT_FOUND", error: "Member not found" };

  const set = input.set ?? [];
  const remove = input.remove ?? [];

  // Only an account admin makes or unmakes account admins.
  if (input.isAccountAdmin !== undefined && !input.actor.person.accountAdmin) {
    return { success: false, code: "FORBIDDEN", error: "Reserved for account admins" };
  }
  if (input.isAccountAdmin === false && member.isAccountAdmin && (await isLastAccountAdmin(member.id))) {
    return { success: false, code: "LAST_ACCOUNT_ADMIN", error: "Cannot remove the last account admin" };
  }

  // Validate buckets and the actor's authority at each touched site.
  const touched = [...set.map((s) => s.bucketId), ...remove];
  const check = await checkBuckets(touched);
  if (!check.ok) return { success: false, code: check.code, error: check.error };
  if (touched.some((id) => !adminAt(input.actor, check.buckets.get(id)?.siteId ?? null))) {
    return { success: false, code: "FORBIDDEN", error: "Requires ADMIN access at this plant" };
  }
  if (set.some((s) => s.level === "ADMIN" && check.buckets.get(s.bucketId)?.kind === "WORKCENTER")) {
    return {
      success: false,
      code: "INVALID_LEVEL",
      error: "ADMIN is a plant level; workcenter buckets go up to MANAGE",
    };
  }

  // Last-plant-admin guard: removing or downgrading the final ADMIN access
  // on a plant bucket orphans the site.
  const existing = await prisma.bucketAccess.findMany({
    where: { userId: member.id, bucketId: { in: touched } },
    select: { bucketId: true, level: true },
  });
  const existingById = new Map(existing.map((e) => [e.bucketId, e.level as BucketLevel]));
  for (const id of touched) {
    const had = existingById.get(id);
    if (had !== "ADMIN") continue;
    const now = remove.includes(id) ? null : set.find((s) => s.bucketId === id)?.level;
    if (now !== "ADMIN" && (await wouldRemoveLastPlantAdmin(id, member.id))) {
      return { success: false, code: "LAST_PLANT_ADMIN", error: "Cannot remove the last plant admin" };
    }
  }

  await prisma.$transaction(async (tx) => {
    if (input.isAccountAdmin !== undefined) {
      await tx.user.update({ where: { id: member.id }, data: { isAccountAdmin: input.isAccountAdmin } });
    }
    await writeAccesses(tx, member.id, set);
    if (remove.length) {
      await tx.bucketAccess.deleteMany({ where: { userId: member.id, bucketId: { in: remove } } });
    }
  });

  return { success: true, access: (await getUserAccess(member.id)) as MemberAccessSummary };
}

/**
 * Remove someone from the account: they are disabled and lose every
 * access, but the user row stays so history still names them. Inviting
 * them again brings them back.
 */
export async function removeMember(userId: string) {
  const member = await findMember(userId);
  if (!member) return { success: false as const, error: "MEMBER_NOT_FOUND" as const };
  if (member.isAccountAdmin && (await isLastAccountAdmin(member.id))) {
    return { success: false as const, error: "LAST_ACCOUNT_ADMIN" as const };
  }

  await prisma.$transaction([
    prisma.bucketAccess.deleteMany({ where: { userId: member.id } }),
    prisma.user.update({ where: { id: member.id }, data: { status: "DISABLED", isAccountAdmin: false } }),
    prisma.refreshToken.updateMany({ where: { userId: member.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  return { success: true as const };
}

/** Remove a member's access at ONE site (all bucket accesses on that site's buckets). */
export async function removeSiteAccess(userId: string, siteId: string) {
  const member = await findMember(userId);
  if (!member) return { success: false as const, error: "MEMBER_NOT_FOUND" as const };

  // The site must keep one plant admin.
  const plantBucket = await prisma.bucket.findFirst({
    where: { siteId, kind: "PLANT" },
    select: { id: true },
  });
  if (plantBucket) {
    const targetAdmin = await prisma.bucketAccess.findFirst({
      where: { bucketId: plantBucket.id, userId: member.id, level: "ADMIN" },
      select: { id: true },
    });
    if (targetAdmin && (await wouldRemoveLastPlantAdmin(plantBucket.id, member.id))) {
      return { success: false as const, error: "LAST_PLANT_ADMIN" as const };
    }
  }

  await prisma.bucketAccess.deleteMany({ where: { userId: member.id, bucket: { siteId } } });
  return { success: true as const };
}

// ── Reads used across the account surface ────────────────────────────────

export async function getUserAccess(userId: string): Promise<MemberAccessSummary | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, systemRole: null },
    select: { isAccountAdmin: true, bucketAccesses: { select: ACCESS_SELECT } },
  });
  return user ? summarize(user.isAccountAdmin, user.bucketAccesses) : null;
}

export async function countMembers(): Promise<number> {
  return prisma.user.count({ where: MEMBER_WHERE });
}
