import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";

// Bucket-era test fixtures: create users with plant/workcenter accesses.
// Replaces the role-assignment helpers from the permission era.

export type Level = "VIEW" | "MANAGE" | "ADMIN";

export async function plantBucketId(siteId: string): Promise<string> {
  const bucket = await prisma.bucket.findFirstOrThrow({
    where: { siteId, kind: "PLANT" },
    select: { id: true },
  });
  return bucket.id;
}

export async function workcenterBucketId(workcenterId: string): Promise<string> {
  const bucket = await prisma.bucket.findUniqueOrThrow({
    where: { workcenterId },
    select: { id: true },
  });
  return bucket.id;
}

/** Ensure the site has a plant bucket (fixtures that create sites via prisma). */
export async function ensurePlantBucket(workspaceId: string, siteId: string, name = "plant"): Promise<string> {
  const existing = await prisma.bucket.findFirst({ where: { siteId, kind: "PLANT" }, select: { id: true } });
  if (existing) return existing.id;
  const bucket = await prisma.bucket.create({
    data: { workspaceId, siteId, kind: "PLANT", name },
    select: { id: true },
  });
  return bucket.id;
}

/** Ensure the workcenter has a bucket (fixtures that create WCs via prisma). */
export async function ensureWorkcenterBucket(
  workspaceId: string,
  siteId: string,
  workcenterId: string,
  name = "cell",
): Promise<string> {
  const existing = await prisma.bucket.findUnique({ where: { workcenterId }, select: { id: true } });
  if (existing) return existing.id;
  const bucket = await prisma.bucket.create({
    data: { workspaceId, siteId, kind: "WORKCENTER", workcenterId, name },
    select: { id: true },
  });
  return bucket.id;
}

export async function setPlantAccess(membershipId: string, siteId: string, level: Level): Promise<void> {
  const bucketId = await plantBucketId(siteId);
  await prisma.bucketAccess.upsert({
    where: { bucketId_membershipId: { bucketId, membershipId } },
    update: { level },
    create: { bucketId, membershipId, level },
  });
}

export async function setWorkcenterAccess(membershipId: string, workcenterId: string, level: Level): Promise<void> {
  const bucketId = await workcenterBucketId(workcenterId);
  await prisma.bucketAccess.upsert({
    where: { bucketId_membershipId: { bucketId, membershipId } },
    update: { level },
    create: { bucketId, membershipId, level },
  });
}

export interface AccessSpec {
  /** Plant accesses: siteId → level. */
  plants?: Array<{ siteId: string; level: Level }>;
  /** Workcenter accesses: workcenterId → level (VIEW | MANAGE). */
  workcenters?: Array<{ workcenterId: string; level: Level }>;
  owner?: boolean;
}

/** Upsert a user + membership + accesses in one call. Returns ids. */
export async function makeUser(
  workspaceId: string,
  email: string,
  password: string,
  access: AccessSpec = {},
): Promise<{ userId: string; membershipId: string }> {
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, status: "ACTIVE" },
    create: { email, passwordHash, firstName: "Test", status: "ACTIVE" },
    select: { id: true },
  });
  const membership = await prisma.workspaceMembership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    update: { workspaceRole: access.owner ? "OWNER" : "MEMBER" },
    create: { userId: user.id, workspaceId, workspaceRole: access.owner ? "OWNER" : "MEMBER" },
    select: { id: true },
  });
  for (const p of access.plants ?? []) {
    await setPlantAccess(membership.id, p.siteId, p.level);
  }
  for (const w of access.workcenters ?? []) {
    await setWorkcenterAccess(membership.id, w.workcenterId, w.level);
  }
  return { userId: user.id, membershipId: membership.id };
}
