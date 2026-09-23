import prisma from "@rw/db";
import { getEffectivePermissions, hasPermission } from "@rw/auth/iam/index";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";

const LIMITED_EMAIL = "limited@test.local";
const LIMITED_PASSWORD = "limited-password-123";
const MEMBER_EMAIL = "dual-vocab-member@test.local";
const ENGINEER_EMAIL = "dual-vocab-engineer@test.local";

// Tier 2: a workspace member with NO role assignments must be denied on
// permission-guarded routes.
describe.skipIf(!process.env.TEST_DATABASE_URL)("permission enforcement (Tier 2)", () => {
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

  it("denies a role-less member on a permission-guarded route", async () => {
    const tokens = await loginAs(server, LIMITED_EMAIL, LIMITED_PASSWORD);
    const res = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toHaveProperty("error");
  });

  it("still allows the role-less member to read their own profile", async () => {
    const tokens = await loginAs(server, LIMITED_EMAIL, LIMITED_PASSWORD);
    const res = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

// Tier 2: during the vocabulary transition, seeded role rows carry BOTH key
// sets, so both old and new permission checks pass against real data through
// the fresh-DB-load path (loadPermissionSnapshot → hasPermission) that
// requirePermission and /users/me use.
describe.skipIf(!process.env.TEST_DATABASE_URL)("dual-vocabulary role data (Tier 2)", () => {
  let workspaceId: string;
  let siteId: string;
  let memberId: string;
  let engineerId: string;

  const seedUser = async (email: string, roleName: string) => {
    const passwordHash = await hashPassword("dual-vocab-password-123");
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, passwordHash, firstName: "Dual", status: "ACTIVE" },
    });
    const membership = await prisma.workspaceMembership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
      update: {},
      create: { userId: user.id, workspaceId },
    });
    const role = await prisma.role.findFirstOrThrow({ where: { workspaceId, name: roleName, isSystem: true } });
    await prisma.roleAssignment.create({ data: { membershipId: membership.id, roleId: role.id, siteId } });
    return user.id;
  };

  beforeAll(async () => {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });
    workspaceId = workspace.id;
    const site = await prisma.site.create({ data: { workspaceId, name: "Dual Vocabulary Test Site" } });
    siteId = site.id;
    memberId = await seedUser(MEMBER_EMAIL, "Plant Member");
    engineerId = await seedUser(ENGINEER_EMAIL, "Plant Engineer");
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [MEMBER_EMAIL, ENGINEER_EMAIL] } } });
    await prisma.site.deleteMany({ where: { id: siteId } });
  });

  it("Plant Member satisfies old reads AND planning:read, but not production:read", async () => {
    expect(await hasPermission(memberId, "status:read", { workspaceId, siteId })).toBe(true);
    expect(await hasPermission(memberId, "planning:read", { workspaceId, siteId })).toBe(true);
    // Target model: member production visibility comes from workcenter
    // grants, so the base tier deliberately lacks production:read.
    expect(await hasPermission(memberId, "production:read", { workspaceId, siteId })).toBe(false);
    expect(await hasPermission(memberId, "planning:write", { workspaceId, siteId })).toBe(false);
  });

  it("Plant Engineer's new-key bundle satisfies implied keys through the same path", async () => {
    const perms = await getEffectivePermissions(engineerId, { workspaceId, siteId });
    expect(perms.has("production:admin")).toBe(true);
    expect(perms.has("production:write")).toBe(true); // implied
    expect(perms.has("production:read")).toBe(true); // implied transitively
    expect(perms.has("planning:read")).toBe(true); // implied
    expect(perms.has("configuration:read")).toBe(true); // implied
    expect(perms.has("plant:admin")).toBe(false);
  });

  it("holds nothing at workspace scope from a site-scoped assignment", async () => {
    expect(await hasPermission(engineerId, "production:admin", { workspaceId })).toBe(false);
  });
});
