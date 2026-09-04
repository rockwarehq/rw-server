import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./global-setup.js";
import { buildServer, type TestServer } from "./helpers/build-server.js";

const FACTORY_ADMIN_EMAIL = "site-remover@test.local";
const FACTORY_ADMIN_PASSWORD = "SiteRemover123!";
const SITE_ONLY_EMAIL = "site-only-member@test.local";
const HYBRID_EMAIL = "hybrid-member@test.local";
const PENDING_EMAIL = "pending-site-member@test.local";
const OTHER_SITE_EMAIL = "other-site-member@test.local";
const CUSTOM_ADMIN_EMAIL = "custom-site-admin@test.local";
const CUSTOM_ADMIN_PASSWORD = "CustomAdmin123!";
const LONE_ADMIN_EMAIL = "lone-site-admin@test.local";
const SECOND_ADMIN_EMAIL = "second-site-admin@test.local";
const ALL_EMAILS = [
  FACTORY_ADMIN_EMAIL,
  SITE_ONLY_EMAIL,
  HYBRID_EMAIL,
  PENDING_EMAIL,
  OTHER_SITE_EMAIL,
  CUSTOM_ADMIN_EMAIL,
  LONE_ADMIN_EMAIL,
  SECOND_ADMIN_EMAIL,
];
const CUSTOM_SITE_ADMIN_ROLE = "Custom Site Admin (member removal)";
const HYBRID_WS_ROLE = "Hybrid Workspace Role (member removal)";

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
  let customAdminToken: string;

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
      assignments: Array<{ roleId: string; siteId: string | null }>;
    },
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(options.password ?? "MemberPass123!"),
        status: options.status ?? "ACTIVE",
      },
    });
    const membership = await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId },
    });
    for (const assignment of options.assignments) {
      await prisma.roleAssignment.create({
        data: { membershipId: membership.id, roleId: assignment.roleId, siteId: assignment.siteId },
      });
    }
    return user.id;
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

  let readOnlyRoleId: string;
  let hybridWsRoleId: string;
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

    const siteA = await prisma.site.findFirstOrThrow({ where: { workspaceId } });
    siteAId = siteA.id;
    const siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId, name: "Member Removal Site B" } },
      update: {},
      create: { name: "Member Removal Site B", workspaceId },
    });
    siteBId = siteB.id;

    const factoryAdminRole = await prisma.role.findFirstOrThrow({
      where: { workspaceId, name: "Plant Admin", scope: "SITE", isSystem: true },
    });
    const readOnlyRole = await prisma.role.findFirstOrThrow({
      where: { workspaceId, name: "Plant Member", scope: "SITE", isSystem: true },
    });
    readOnlyRoleId = readOnlyRole.id;
    const customSiteAdminRole = await prisma.role.create({
      data: {
        workspaceId,
        name: CUSTOM_SITE_ADMIN_ROLE,
        scope: "SITE",
        // facility:read is what makes a site "accessible" for switch-site
        permissions: ["facility:read", "user:read", "user:admin"],
        isSystem: false,
      },
    });
    const hybridWsRole = await prisma.role.create({
      data: {
        workspaceId,
        name: HYBRID_WS_ROLE,
        scope: "WORKSPACE",
        permissions: ["dashboard:read"],
        isSystem: false,
      },
    });
    hybridWsRoleId = hybridWsRole.id;

    factoryAdminUserId = await createMember(FACTORY_ADMIN_EMAIL, {
      password: FACTORY_ADMIN_PASSWORD,
      assignments: [{ roleId: factoryAdminRole.id, siteId: siteAId }],
    });
    await createMember(CUSTOM_ADMIN_EMAIL, {
      password: CUSTOM_ADMIN_PASSWORD,
      assignments: [{ roleId: customSiteAdminRole.id, siteId: siteAId }],
    });
    siteOnlyUserId = await createMember(SITE_ONLY_EMAIL, {
      assignments: [{ roleId: readOnlyRoleId, siteId: siteAId }],
    });
    hybridUserId = await createMember(HYBRID_EMAIL, {
      assignments: [
        { roleId: readOnlyRoleId, siteId: siteAId },
        { roleId: hybridWsRole.id, siteId: null },
      ],
    });
    pendingUserId = await createMember(PENDING_EMAIL, {
      status: "PENDING",
      assignments: [{ roleId: readOnlyRoleId, siteId: siteAId }],
    });
    otherSiteUserId = await createMember(OTHER_SITE_EMAIL, {
      assignments: [{ roleId: readOnlyRoleId, siteId: siteBId }],
    });

    adminToken = await switchSite(await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD), siteAId);
    factoryAdminToken = await switchSite(
      await login(FACTORY_ADMIN_EMAIL, FACTORY_ADMIN_PASSWORD),
      siteAId,
    );
    customAdminToken = await switchSite(
      await login(CUSTOM_ADMIN_EMAIL, CUSTOM_ADMIN_PASSWORD),
      siteAId,
    );
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: ALL_EMAILS } } });
    await prisma.role.deleteMany({ where: { name: { in: [CUSTOM_SITE_ADMIN_ROLE, HYBRID_WS_ROLE] } } });
    await prisma.site.deleteMany({ where: { name: "Member Removal Site B" } });
    await server.close();
  });

  it("seeded Plant Admin holds site-scoped user:admin", async () => {
    const role = await prisma.role.findFirstOrThrow({
      where: { workspaceId, name: "Plant Admin", scope: "SITE", isSystem: true },
    });
    expect(role.permissions).toContain("user:admin");
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

  it("hybrid member keeps membership and workspace role after site removal", async () => {
    const res = await removeSiteAccess(adminToken, hybridUserId);
    expect(res.statusCode).toBe(200);

    const membership = await prisma.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: hybridUserId, workspaceId } },
      include: { roleAssignments: true },
    });
    expect(membership.roleAssignments).toHaveLength(1);
    expect(membership.roleAssignments[0]?.siteId).toBeNull();
    expect(membership.roleAssignments[0]?.roleId).toBe(hybridWsRoleId);
  });

  it("pending site-only invitee is fully deleted with an INVITE_REVOKED audit", async () => {
    const res = await removeSiteAccess(adminToken, pendingUserId);
    expect(res.statusCode).toBe(200);

    const user = await prisma.user.findUnique({ where: { id: pendingUserId } });
    expect(user).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "INVITE_REVOKED", userId: pendingUserId },
    });
    expect(audit).not.toBeNull();
  });

  it("404 when the member has no access to the caller's site", async () => {
    const res = await removeSiteAccess(adminToken, otherSiteUserId);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Member has no access to this site" });
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

  it("tightened org route: site-scoped user:admin cannot delete workspace memberships", async () => {
    const res = await removeMember(customAdminToken, otherSiteUserId);
    expect(res.statusCode).toBe(403);

    // Same actor CAN still use the site-scoped removal at their own site
    const target = await createMember("scoped-target@test.local", {
      assignments: [{ roleId: readOnlyRoleId, siteId: siteAId }],
    });
    const siteRes = await removeSiteAccess(customAdminToken, target);
    expect(siteRes.statusCode).toBe(200);
    await prisma.user.deleteMany({ where: { email: "scoped-target@test.local" } });
  });

  it("workspace-scoped user:admin still removes members org-wide", async () => {
    const res = await removeMember(adminToken, otherSiteUserId);
    expect(res.statusCode).toBe(200);
    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: otherSiteUserId, workspaceId } },
    });
    expect(membership).toBeNull();
  });

  it("blocks demoting the last plant admin at a site until another admin exists", async () => {
    const plantAdminRole = await prisma.role.findFirstOrThrow({
      where: { workspaceId, name: "Plant Admin", scope: "SITE", isSystem: true },
    });
    // Site B has no admins yet — this member becomes its only one.
    const loneAdminId = await createMember(LONE_ADMIN_EMAIL, {
      assignments: [{ roleId: plantAdminRole.id, siteId: siteBId }],
    });
    const adminSiteBToken = await switchSite(adminToken, siteBId);
    const demote = (token: string, userId: string) =>
      server.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/members/${userId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { roleId: readOnlyRoleId },
        remoteAddress: nextIp(),
      });

    const blocked = await demote(adminSiteBToken, loneAdminId);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json<{ error: string }>().error).toMatch(/last plant admin/i);

    // A second admin at the site unblocks the demotion.
    await createMember(SECOND_ADMIN_EMAIL, {
      assignments: [{ roleId: plantAdminRole.id, siteId: siteBId }],
    });
    const allowed = await demote(adminSiteBToken, loneAdminId);
    expect(allowed.statusCode).toBe(200);
  });
});
