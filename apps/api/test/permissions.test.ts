import prisma from "@rw/db";
import { authorize } from "@rw/auth/iam/policy";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { ensurePlantBucket, ensureWorkcenterBucket, makeUser } from "./helpers/access.js";

const LIMITED_EMAIL = "limited@test.local";
const LIMITED_PASSWORD = "limited-password-123";

// Tier 2: a workspace member with NO bucket access must be denied on
// gated routes.
describe.skipIf(!process.env.TEST_DATABASE_URL)("access enforcement (Tier 2)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });
    const passwordHash = await hashPassword(LIMITED_PASSWORD);
    const limited = await prisma.user.upsert({
      where: { email: LIMITED_EMAIL },
      update: {},
      create: { email: LIMITED_EMAIL, passwordHash, firstName: "Limited", status: "ACTIVE" },
    });
    await prisma.workspaceMembership.upsert({
      where: { userId_workspaceId: { userId: limited.id, workspaceId: workspace.id } },
      update: {},
      create: { userId: limited.id, workspaceId: workspace.id },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: LIMITED_EMAIL } });
    await server.close();
  });

  it("denies a bucket-less member on a gated route", async () => {
    const tokens = await loginAs(server, LIMITED_EMAIL, LIMITED_PASSWORD);
    const res = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toHaveProperty("error");
  });

  it("still allows the bucket-less member to read their own profile", async () => {
    const tokens = await loginAs(server, LIMITED_EMAIL, LIMITED_PASSWORD);
    const res = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

// Tier 2: the bucket model evaluated end to end against real rows through
// the fresh-DB-load path (the one requireTier and no-snapshot callers use).
describe.skipIf(!process.env.TEST_DATABASE_URL)("bucket access data (Tier 2)", () => {
  const EMAILS = {
    member: "bucket-data-member@test.local",
    crew: "bucket-data-crew@test.local",
    manager: "bucket-data-manager@test.local",
  };
  let workspaceId: string;
  let siteId: string;
  let wc1: string;
  let wc2: string;
  let stationInWc1: string;
  let users: Record<keyof typeof EMAILS, { userId: string }>;

  const iamFor = (userId: string) =>
    ({
      principal: "USER",
      validToken: true,
      id: userId,
      email: "x@test.local",
      workspaceId,
    }) as never;

  beforeAll(async () => {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });
    workspaceId = workspace.id;
    const site = await prisma.site.create({ data: { workspaceId, name: "Bucket Data Site" }, select: { id: true } });
    siteId = site.id;
    await ensurePlantBucket(workspaceId, siteId, "Bucket Data Site");
    const w1 = await prisma.workcenter.create({ data: { siteId, name: "bd-wc-1" }, select: { id: true } });
    const w2 = await prisma.workcenter.create({ data: { siteId, name: "bd-wc-2" }, select: { id: true } });
    wc1 = w1.id;
    wc2 = w2.id;
    await ensureWorkcenterBucket(workspaceId, siteId, wc1, "bd-wc-1");
    await ensureWorkcenterBucket(workspaceId, siteId, wc2, "bd-wc-2");
    const s1 = await prisma.station.create({
      data: { siteId, workcenterId: wc1, name: "bd-s1" },
      select: { id: true },
    });
    stationInWc1 = s1.id;

    users = {
      member: await makeUser(workspaceId, EMAILS.member, "bucket-data-pass-1", {
        plants: [{ siteId, tier: "VIEW" }],
      }),
      crew: await makeUser(workspaceId, EMAILS.crew, "bucket-data-pass-1", {
        workcenters: [{ workcenterId: wc1, tier: "MANAGE" }],
      }),
      manager: await makeUser(workspaceId, EMAILS.manager, "bucket-data-pass-1", {
        plants: [{ siteId, tier: "MANAGE" }],
      }),
    };
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await prisma.site.deleteMany({ where: { id: siteId } });
  });

  it("member: reads plant things, sees no floor, writes nothing", async () => {
    const iam = iamFor(users.member.userId);
    expect((await authorize(iam, { tier: "VIEW", scope: { kind: "site", siteId } })).ok).toBe(true);
    expect((await authorize(iam, { tier: "MANAGE", scope: { kind: "site", siteId } })).ok).toBe(false);
    expect((await authorize(iam, { tier: "VIEW", scope: { kind: "station", id: stationInWc1 } })).ok).toBe(false);
  });

  it("crew: member of the plant via the hook, manages only their own cell", async () => {
    const iam = iamFor(users.crew.userId);
    // Hook: workcenter access makes them a plant member.
    expect((await authorize(iam, { tier: "VIEW", scope: { kind: "site", siteId } })).ok).toBe(true);
    // Their cell, including configuration.
    expect((await authorize(iam, { tier: "MANAGE", scope: { kind: "station", id: stationInWc1 } })).ok).toBe(true);
    // Not the other cell, not the plant.
    expect((await authorize(iam, { tier: "MANAGE", scope: { kind: "site", siteId, workcenterId: wc2 } })).ok).toBe(
      false,
    );
    expect((await authorize(iam, { tier: "MANAGE", scope: { kind: "site", siteId } })).ok).toBe(false);
  });

  it("manager: the cascade manages every cell with zero per-cell rows", async () => {
    const iam = iamFor(users.manager.userId);
    expect((await authorize(iam, { tier: "MANAGE", scope: { kind: "station", id: stationInWc1 } })).ok).toBe(true);
    expect((await authorize(iam, { tier: "MANAGE", scope: { kind: "site", siteId, workcenterId: wc2 } })).ok).toBe(
      true,
    );
    // The reserved shelf stays shut.
    expect((await authorize(iam, { tier: "ADMIN", scope: { kind: "site", siteId } })).ok).toBe(false);
  });
});
