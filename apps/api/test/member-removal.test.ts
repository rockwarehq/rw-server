import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./global-setup.js";
import { ensurePlantBucket, makeUser, plantBucketId, type Level } from "./helpers/access.js";
import { buildServer, type TestServer } from "./helpers/build-server.js";

const FACTORY_ADMIN_EMAIL = "site-remover@test.local";
const FACTORY_ADMIN_PASSWORD = "SiteRemover123!";
const SITE_ONLY_EMAIL = "site-only-member@test.local";
const HYBRID_EMAIL = "hybrid-member@test.local";
const PENDING_EMAIL = "pending-site-member@test.local";
const OTHER_SITE_EMAIL = "other-site-member@test.local";
const SECOND_SITE_ADMIN_EMAIL = "custom-site-admin@test.local";
const SECOND_SITE_ADMIN_PASSWORD = "CustomAdmin123!";
const LONE_ADMIN_EMAIL = "lone-site-admin@test.local";
const SECOND_ADMIN_EMAIL = "second-site-admin@test.local";
const ALL_EMAILS = [
  FACTORY_ADMIN_EMAIL,
  SITE_ONLY_EMAIL,
  HYBRID_EMAIL,
  PENDING_EMAIL,
  OTHER_SITE_EMAIL,
  SECOND_SITE_ADMIN_EMAIL,
  LONE_ADMIN_EMAIL,
  SECOND_ADMIN_EMAIL,
];

let ipTail = 1;
function nextIp(): string {
  return `10.97.0.${ipTail++}`;
}

// Tier 2: needs a migrated + seeded Postgres (TEST_DATABASE_URL).
describe.skipIf(!process.env.TEST_DATABASE_URL)("member removal (Tier 2)", () => {
  let server: TestServer;
  let workspaceId: string;
  let siteAId: string;
  let siteBId: string;
  let adminToken: string;
  let factoryAdminToken: string;
  let secondSiteAdminToken: string;

  async function login(email: string, password: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ accessToken: string }>().accessToken;
  }

  async function switchSite(token: string, siteId: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/auth/switch-site",
      headers: { authorization: `Bearer ${token}` },
      payload: { siteId },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ accessToken: string }>().accessToken;
  }

  async function createMember(
    email: string,
    options: {
      status?: "ACTIVE" | "PENDING";
      password?: string;
      plants: Array<{ siteId: string; level: Level }>;
    },
  ): Promise<string> {
    const { userId } = await makeUser(workspaceId, email, options.password ?? "MemberPass123!", {
      plants: options.plants,
    });
    if (options.status === "PENDING") {
      await prisma.user.update({ where: { id: userId }, data: { status: "PENDING" } });
    }
    return userId;
  }

  function removeSiteAccess(token: string, userId: string) {
    return server.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/members/${userId}/site-access`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: nextIp(),
    });
  }

  function removeMember(token: string, userId: string) {
    return server.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/members/${userId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: nextIp(),
    });
  }

  let siteOnlyUserId: string;
  let hybridUserId: string;
  let pendingUserId: string;
  let otherSiteUserId: string;
  let factoryAdminUserId: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });
    workspaceId = workspace.id;

    const siteA = await prisma.site.findFirstOrThrow({ where: { workspaceId, name: "Rockware" } });
    siteAId = siteA.id;
    const siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId, name: "Member Removal Site B" } },
      update: {},
      create: { name: "Member Removal Site B", workspaceId },
    });
    siteBId = siteB.id;
    // Sites created via raw prisma need their plant bucket healed in.
    await ensurePlantBucket(workspaceId, siteBId, "Member Removal Site B");

    factoryAdminUserId = await createMember(FACTORY_ADMIN_EMAIL, {
      password: FACTORY_ADMIN_PASSWORD,
      plants: [{ siteId: siteAId, level: "ADMIN" }],
    });
    // A second, independent plant ADMIN at site A (the old custom-role admin).
    await createMember(SECOND_SITE_ADMIN_EMAIL, {
      password: SECOND_SITE_ADMIN_PASSWORD,
      plants: [{ siteId: siteAId, level: "ADMIN" }],
    });
    siteOnlyUserId = await createMember(SITE_ONLY_EMAIL, {
      plants: [{ siteId: siteAId, level: "VIEW" }],
    });
    // "Hybrid": access at both sites, so removing site A leaves site B.
    hybridUserId = await createMember(HYBRID_EMAIL, {
      plants: [
        { siteId: siteAId, level: "VIEW" },
        { siteId: siteBId, level: "VIEW" },
      ],
    });
    pendingUserId = await createMember(PENDING_EMAIL, {
      status: "PENDING",
      plants: [{ siteId: siteAId, level: "VIEW" }],
    });
    otherSiteUserId = await createMember(OTHER_SITE_EMAIL, {
      plants: [{ siteId: siteBId, level: "VIEW" }],
    });

    adminToken = await switchSite(await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD), siteAId);
    factoryAdminToken = await switchSite(
      await login(FACTORY_ADMIN_EMAIL, FACTORY_ADMIN_PASSWORD),
      siteAId,
    );
    secondSiteAdminToken = await switchSite(
      await login(SECOND_SITE_ADMIN_EMAIL, SECOND_SITE_ADMIN_PASSWORD),
      siteAId,
    );
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: ALL_EMAILS } } });
    await prisma.site.deleteMany({ where: { name: "Member Removal Site B" } });
    await server.close();
  });

  it("plant ADMIN access stands in for the old Plant Admin role", async () => {
    const bucketId = await plantBucketId(siteAId);
    const access = await prisma.bucketAccess.findFirst({
      where: { bucketId, membership: { userId: factoryAdminUserId } },
      select: { level: true },
    });
    expect(access?.level).toBe("ADMIN");
  });

  it("factory admin removes a site-only member; membership cascades away", async () => {
    const res = await removeSiteAccess(factoryAdminToken, siteOnlyUserId);
    expect(res.statusCode).toBe(200);

    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: siteOnlyUserId, workspaceId } },
    });
    expect(membership).toBeNull();
    // ACTIVE user survives; only the membership is gone
    const user = await prisma.user.findUnique({ where: { id: siteOnlyUserId } });
    expect(user?.status).toBe("ACTIVE");
  });

  it("hybrid member keeps membership and other-site access after site removal", async () => {
    const res = await removeSiteAccess(adminToken, hybridUserId);
    expect(res.statusCode).toBe(200);

    const membership = await prisma.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: hybridUserId, workspaceId } },
      include: { bucketAccesses: { include: { bucket: true } } },
    });
    expect(membership.bucketAccesses).toHaveLength(1);
    expect(membership.bucketAccesses[0]?.bucket.siteId).toBe(siteBId);
  });

  it("pending site-only invitee loses the membership; the user row survives", async () => {
    const res = await removeSiteAccess(adminToken, pendingUserId);
    expect(res.statusCode).toBe(200);

    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: pendingUserId, workspaceId } },
    });
    expect(membership).toBeNull();
    // Deleting the pending user is the invite-revoke route's job, not this
    // one's — the row stays PENDING.
    const user = await prisma.user.findUnique({ where: { id: pendingUserId } });
    expect(user?.status).toBe("PENDING");
  });

  it("removing access at a site the member never had is a harmless no-op", async () => {
    const res = await removeSiteAccess(adminToken, otherSiteUserId);
    expect(res.statusCode).toBe(200);

    const membership = await prisma.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: otherSiteUserId, workspaceId } },
      include: { bucketAccesses: { include: { bucket: true } } },
    });
    expect(membership.bucketAccesses).toHaveLength(1);
    expect(membership.bucketAccesses[0]?.bucket.siteId).toBe(siteBId);
  });

  it("404 for an unknown member", async () => {
    const res = await removeSiteAccess(adminToken, "00000000-0000-0000-0000-000000000099");
    expect(res.statusCode).toBe(404);
  });

  it("400 on self-removal", async () => {
    const res = await removeSiteAccess(factoryAdminToken, factoryAdminUserId);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Cannot remove yourself" });
  });

  it("tightened org route: a site plant ADMIN cannot delete workspace memberships", async () => {
    const res = await removeMember(secondSiteAdminToken, otherSiteUserId);
    expect(res.statusCode).toBe(403);

    // Same actor CAN still use the site-scoped removal at their own site
    const target = await createMember("scoped-target@test.local", {
      plants: [{ siteId: siteAId, level: "VIEW" }],
    });
    const siteRes = await removeSiteAccess(secondSiteAdminToken, target);
    expect(siteRes.statusCode).toBe(200);
    await prisma.user.deleteMany({ where: { email: "scoped-target@test.local" } });
  });

  it("workspace owner still removes members org-wide", async () => {
    const res = await removeMember(adminToken, otherSiteUserId);
    expect(res.statusCode).toBe(200);
    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: otherSiteUserId, workspaceId } },
    });
    expect(membership).toBeNull();
  });

  it("blocks demoting the last plant admin at a site until another admin exists", async () => {
    // Site B has no admins yet — this member becomes its only one.
    const loneAdminId = await createMember(LONE_ADMIN_EMAIL, {
      plants: [{ siteId: siteBId, level: "ADMIN" }],
    });
    const siteBBucketId = await plantBucketId(siteBId);
    const demote = (userId: string) =>
      server.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/members/${userId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { set: [{ bucketId: siteBBucketId, level: "VIEW" }] },
        remoteAddress: nextIp(),
      });

    const blocked = await demote(loneAdminId);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json<{ error: string }>().error).toMatch(/last plant admin/i);

    // A second admin at the site unblocks the demotion.
    await createMember(SECOND_ADMIN_EMAIL, {
      plants: [{ siteId: siteBId, level: "ADMIN" }],
    });
    const allowed = await demote(loneAdminId);
    expect(allowed.statusCode).toBe(200);
  });
});
