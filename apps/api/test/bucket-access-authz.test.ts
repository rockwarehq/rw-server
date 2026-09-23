import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";
import { ensurePlantBucket, ensureWorkcenterBucket, makeUser, workcenterBucketId } from "./helpers/access.js";

// Tier 2: the bucket-access surface end to end — crew narrowing on floor
// lists, the /users/me access shape, and the bucket administration rpc
// with its guards.

const PASSWORD = "bucket-authz-pass-1";
const EMAILS = {
  crew: "ba-crew@test.local",
  member: "ba-member@test.local",
  admin: "ba-admin@test.local",
  admin2: "ba-admin2@test.local",
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("bucket access authorization (Tier 2)", () => {
  let server: TestServer;
  let workspaceId: string;
  let siteId: string;
  let wc1: string;
  let wc2: string;
  let wc1Bucket: string;
  let crewUserId: string;
  const tokens: Record<keyof typeof EMAILS, string> = {} as never;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const workspace = await prisma.workspace.findFirstOrThrow();
    workspaceId = workspace.id;
    await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await prisma.site.deleteMany({ where: { workspaceId, name: "Bucket Authz Site" } });

    const site = await prisma.site.create({ data: { workspaceId, name: "Bucket Authz Site" }, select: { id: true } });
    siteId = site.id;
    await ensurePlantBucket(workspaceId, siteId, "Bucket Authz Site");
    wc1 = (await prisma.workcenter.create({ data: { siteId, name: "ba-wc-1" }, select: { id: true } })).id;
    wc2 = (await prisma.workcenter.create({ data: { siteId, name: "ba-wc-2" }, select: { id: true } })).id;
    await ensureWorkcenterBucket(workspaceId, siteId, wc1, "ba-wc-1");
    await ensureWorkcenterBucket(workspaceId, siteId, wc2, "ba-wc-2");
    wc1Bucket = await workcenterBucketId(wc1);
    await prisma.station.create({ data: { siteId, workcenterId: wc1, name: "ba-s1" } });
    await prisma.station.create({ data: { siteId, workcenterId: wc2, name: "ba-s2" } });
    await prisma.station.create({ data: { siteId, name: "ba-s-null" } });

    const crew = await makeUser(EMAILS.crew, PASSWORD, {
      workcenters: [{ workcenterId: wc1, level: "VIEW" }],
    });
    crewUserId = crew.userId;
    await makeUser(EMAILS.member, PASSWORD, { plants: [{ siteId, level: "VIEW" }] });
    await makeUser(EMAILS.admin, PASSWORD, { plants: [{ siteId, level: "ADMIN" }] });
    await makeUser(EMAILS.admin2, PASSWORD, { plants: [{ siteId, level: "ADMIN" }] });

    for (const key of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      tokens[key] = (await loginAs(server, EMAILS[key], PASSWORD)).accessToken;
    }
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await prisma.site.deleteMany({ where: { id: siteId } });
    await server.close();
  });

  it("floor lists narrow to the crew's cells; site-level rows stay readable", async () => {
    const res = await rpcCall(server, "station/list", { siteId }, tokens.crew);
    expect(res.statusCode).toBe(200);
    const names = (res.json as { data: Array<{ name: string }> }).data.map((s) => s.name).sort();
    // Own cell + the workcenter-less station (a plant thing) — not wc2's.
    expect(names).toEqual(["ba-s-null", "ba-s1"]);
  });

  it("plant members hold no floor list access at all", async () => {
    const res = await rpcCall(server, "station/list", { siteId }, tokens.member);
    expect(res.statusCode).toBe(403);
  });

  it("/users/me tells the whole access story: direct, hook and levels", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${tokens.crew}` },
    });
    expect(res.statusCode).toBe(200);
    const access = (res.json() as { access: { isAccountAdmin: boolean; buckets: Array<Record<string, unknown>> } })
      .access;
    expect(access.isAccountAdmin).toBe(false);
    const byKind = new Map(access.buckets.map((b) => [`${b.kind}:${b.via}`, b.level]));
    expect(byKind.get("WORKCENTER:direct")).toBe("VIEW");
    expect(byKind.get("PLANT:member")).toBe("VIEW");
  });

  it("bucket rpc: members roster is ADMIN-only; setAccess upgrades a level", async () => {
    const denied = await rpcCall(server, "bucket/members", { bucketId: wc1Bucket }, tokens.crew);
    expect(denied.statusCode).toBe(403);

    const roster = await rpcCall(server, "bucket/members", { bucketId: wc1Bucket }, tokens.admin);
    expect(roster.statusCode).toBe(200);
    expect(
      (roster.json as { members: Array<{ user: { email: string } }> }).members.map((m) => m.user.email),
    ).toContain(EMAILS.crew);

    const upgraded = await rpcCall(
      server,
      "bucket/setAccess",
      { userId: crewUserId, bucketId: wc1Bucket, level: "MANAGE" },
      tokens.admin,
    );
    expect(upgraded.statusCode).toBe(200);

    // Members cannot hand out access.
    const memberTry = await rpcCall(
      server,
      "bucket/setAccess",
      { userId: crewUserId, bucketId: wc1Bucket, level: "VIEW" },
      tokens.member,
    );
    expect(memberTry.statusCode).toBe(403);

    // Workcenter buckets top out at MANAGE.
    const badLevel = await rpcCall(
      server,
      "bucket/setAccess",
      { userId: crewUserId, bucketId: wc1Bucket, level: "ADMIN" },
      tokens.admin,
    );
    expect(badLevel.statusCode).toBe(400);
  });

  it("the last plant admin cannot be removed or downgraded", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
    const plant = await prisma.bucket.findFirstOrThrow({
      where: { siteId, kind: "PLANT" },
      select: { id: true },
    });
    const admin2 = await prisma.user.findUniqueOrThrow({ where: { email: EMAILS.admin2 }, select: { id: true } });

    // Two admins: removing one is fine.
    const removeOk = await rpcCall(
      server,
      "bucket/removeAccess",
      { userId: admin2.id, bucketId: plant.id },
      tokens.admin,
    );
    expect(removeOk.statusCode).toBe(200);

    // Now the actor is the last one: self-downgrade and removal refuse.
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: EMAILS.admin }, select: { id: true } });
    const downgrade = await rpcCall(
      server,
      "bucket/setAccess",
      { userId: adminUser.id, bucketId: plant.id, level: "MANAGE" },
      tokens.admin,
    );
    expect(downgrade.statusCode).toBe(400);
    const remove = await rpcCall(
      server,
      "bucket/removeAccess",
      { userId: adminUser.id, bucketId: plant.id },
      tokens.admin,
    );
    expect(remove.statusCode).toBe(400);
    void workspace;
  });
});
