import prisma from "@rw/db";
import { loadPerson, UserAccess } from "@rw/auth/iam/access";
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

    const passwordHash = await hashPassword(LIMITED_PASSWORD);
    await prisma.user.upsert({
      where: { email: LIMITED_EMAIL },
      update: {},
      create: { email: LIMITED_EMAIL, passwordHash, firstName: "Limited", status: "ACTIVE" },
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
// the same person loader the auth plugin and session use.
describe.skipIf(!process.env.TEST_DATABASE_URL)("bucket access data (Tier 2)", () => {
  const EMAILS = {
    member: "bucket-data-member@test.local",
    crew: "bucket-data-crew@test.local",
    manager: "bucket-data-manager@test.local",
    admin: "bucket-data-admin@test.local",
  };
  let workspaceId: string;
  let siteId: string;
  let wc1: string;
  let wc2: string;
  let stationInWc1: string;
  let users: Record<keyof typeof EMAILS, { userId: string }>;

  const accessFor = async (userId: string) => {
    const person = await loadPerson(userId);
    if (!person) throw new Error("no person");
    return new UserAccess(person, siteId);
  };
  const allowed = (check: Promise<unknown>) =>
    check.then(
      () => true,
      () => false,
    );

  beforeAll(async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
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
      member: await makeUser(EMAILS.member, "bucket-data-pass-1", {
        plants: [{ siteId, level: "VIEW" }],
      }),
      crew: await makeUser(EMAILS.crew, "bucket-data-pass-1", {
        workcenters: [{ workcenterId: wc1, level: "MANAGE" }],
      }),
      manager: await makeUser(EMAILS.manager, "bucket-data-pass-1", {
        plants: [{ siteId, level: "MANAGE" }],
      }),
      admin: await makeUser(EMAILS.admin, "bucket-data-pass-1", {
        plants: [{ siteId, level: "ADMIN" }],
      }),
    };
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await prisma.site.deleteMany({ where: { id: siteId } });
  });

  it("member: reads plant things, sees no floor, writes nothing", async () => {
    const access = await accessFor(users.member.userId);
    expect(await allowed(access.require("VIEW", { site: siteId }))).toBe(true);
    expect(await allowed(access.require("MANAGE", { site: siteId }))).toBe(false);
    expect(await allowed(access.require("VIEW", { station: stationInWc1 }))).toBe(false);
  });

  it("crew: reads the plant via the hook, runs only their own cell", async () => {
    const access = await accessFor(users.crew.userId);
    // Hook: workcenter access lets them read the plant.
    expect(await allowed(access.require("VIEW", { site: siteId }))).toBe(true);
    // They run their cell, but setting it up is plant ADMIN.
    expect(await allowed(access.require("MANAGE", { station: stationInWc1 }))).toBe(true);
    expect(await allowed(access.require("ADMIN", { station: stationInWc1 }))).toBe(false);
    // Not the other cell, not the plant.
    expect(await allowed(access.require("MANAGE", { workcenter: wc2 }))).toBe(false);
    expect(await allowed(access.require("MANAGE", { site: siteId }))).toBe(false);
  });

  it("plant MANAGE (member): writes plant things, reaches no cell it was not given", async () => {
    const access = await accessFor(users.manager.userId);
    expect(await allowed(access.require("MANAGE", { site: siteId }))).toBe(true);
    expect(await allowed(access.require("VIEW", { station: stationInWc1 }))).toBe(false);
    expect(await allowed(access.require("VIEW", { workcenter: wc2 }))).toBe(false);
    // Setup and people stay with ADMIN.
    expect(await allowed(access.require("ADMIN", { site: siteId }))).toBe(false);
  });

  it("admin: the cascade manages every cell with zero per-cell rows", async () => {
    const access = await accessFor(users.admin.userId);
    expect(await allowed(access.require("MANAGE", { station: stationInWc1 }))).toBe(true);
    expect(await allowed(access.require("MANAGE", { workcenter: wc2 }))).toBe(true);
    expect(await allowed(access.require("ADMIN", { station: stationInWc1 }))).toBe(true);
  });
});
