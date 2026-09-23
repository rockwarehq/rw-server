import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";

// Bucket-era test fixtures: create users with plant/workcenter accesses.
// The account is the one workspace; users carry no membership.

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

export async function setPlantAccess(userId: string, siteId: string, level: Level): Promise<void> {
  const bucketId = await plantBucketId(siteId);
  await prisma.bucketAccess.upsert({
    where: { bucketId_userId: { bucketId, userId } },
    update: { level },
    create: { bucketId, userId, level },
  });
}

export async function setWorkcenterAccess(userId: string, workcenterId: string, level: Level): Promise<void> {
  const bucketId = await workcenterBucketId(workcenterId);
  await prisma.bucketAccess.upsert({
    where: { bucketId_userId: { bucketId, userId } },
    update: { level },
    create: { bucketId, userId, level },
  });
}

export interface AccessSpec {
  /** Plant accesses: siteId → level. */
  plants?: Array<{ siteId: string; level: Level }>;
  /** Workcenter accesses: workcenterId → level (VIEW | MANAGE). */
  workcenters?: Array<{ workcenterId: string; level: Level }>;
  accountAdmin?: boolean;
}

/** Upsert an active user with their accesses in one call. Returns the id. */
export async function makeUser(email: string, password: string, access: AccessSpec = {}): Promise<{ userId: string }> {
  const passwordHash = await hashPassword(password);
  const accountAdmin = access.accountAdmin === true;
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, status: "ACTIVE", isAccountAdmin: accountAdmin },
    create: { email, passwordHash, firstName: "Test", status: "ACTIVE", isAccountAdmin: accountAdmin },
    select: { id: true },
  });
  for (const p of access.plants ?? []) {
    await setPlantAccess(user.id, p.siteId, p.level);
  }
  for (const w of access.workcenters ?? []) {
    await setWorkcenterAccess(user.id, w.workcenterId, w.level);
  }
  return { userId: user.id };
}
