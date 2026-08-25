import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePasswordStrength } from "../src/services/validation.js";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./global-setup.js";
import { buildServer, type TestServer } from "./helpers/build-server.js";

const USER_ADMIN_EMAIL = "user-admin@test.local";
const USER_ADMIN_PASSWORD = "UserAdminPass123!";
const TARGET_EMAIL = "reset-target@test.local";
const TARGET_PASSWORD = "TargetPass123!";
const SECOND_OWNER_EMAIL = "second-owner@test.local";
const SYSTEM_USER_EMAIL = "system-reset@test.local";
const ROLE_NAME = "Test User Admin (password reset)";

let ipTail = 1;
function nextIp(): string {
  return `10.98.0.${ipTail++}`;
}

async function login(server: TestServer, email: string, password: string) {
  const res = await server.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
    remoteAddress: nextIp(),
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed (${res.statusCode}): ${res.body}`);
  }
  return res.json() as { accessToken: string; refreshToken: string };
}

async function createMember(workspaceId: string, email: string, password: string, roleId?: string) {
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, status: "ACTIVE" },
  });
  const membership = await prisma.workspaceMembership.create({
    data: { userId: user.id, workspaceId },
  });
  if (roleId) {
    await prisma.roleAssignment.create({
      data: { membershipId: membership.id, roleId, siteId: null },
    });
  }
  return user;
}

// Tier 2: needs a migrated + seeded Postgres (TEST_DATABASE_URL).
describe.skipIf(!process.env.TEST_DATABASE_URL)("admin password reset (Tier 2)", () => {
  let server: TestServer;
  let target: { id: string };
  let systemUser: { id: string };
  let secondOwner: { id: string };
  let adminToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });

    // Workspace-scoped user:admin role that is NOT an owner role
    const role = await prisma.role.create({
      data: {
        workspaceId: workspace.id,
        name: ROLE_NAME,
        scope: "WORKSPACE",
        permissions: ["user:read", "user:write", "user:admin"],
        isSystem: false,
      },
    });

    await createMember(workspace.id, USER_ADMIN_EMAIL, USER_ADMIN_PASSWORD, role.id);
    target = await createMember(workspace.id, TARGET_EMAIL, TARGET_PASSWORD);

    const ownerRole = await prisma.role.findFirstOrThrow({
      where: { workspaceId: workspace.id, name: "Company Administrator", scope: "WORKSPACE", isSystem: true },
    });
    secondOwner = await createMember(workspace.id, SECOND_OWNER_EMAIL, "SecondOwner123!", ownerRole.id);

    systemUser = await prisma.user.create({
      data: {
        email: SYSTEM_USER_EMAIL,
        passwordHash: await hashPassword("SystemUser123!"),
        status: "ACTIVE",
        systemRole: "SUPPORT",
      },
    });

    adminToken = (await login(server, USER_ADMIN_EMAIL, USER_ADMIN_PASSWORD)).accessToken;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { in: [USER_ADMIN_EMAIL, TARGET_EMAIL, SECOND_OWNER_EMAIL, SYSTEM_USER_EMAIL] } },
    });
    await prisma.role.deleteMany({ where: { name: ROLE_NAME } });
    await server.close();
  });

  it("sets an explicit permanent password the target can log in with", async () => {
    const oldTokens = await login(server, TARGET_EMAIL, TARGET_PASSWORD);

    const res = await server.inject({
      method: "POST",
      url: `/users/${target.id}/password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { password: "ExplicitPerm123!", mode: "permanent" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ success: true, mustChangePassword: false });
    expect(body.temporaryPassword).toBeUndefined();

    // Target's old session is revoked
    const refresh = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: oldTokens.refreshToken },
      remoteAddress: nextIp(),
    });
    expect(refresh.statusCode).toBe(401);

    const relogin = await login(server, TARGET_EMAIL, "ExplicitPerm123!");
    expect(relogin.accessToken).toBeTruthy();

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.mustChangePassword).toBe(false);
  });

  it("generates a strong temporary password when none is provided", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/users/${target.id}/password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; mustChangePassword: boolean; temporaryPassword?: string };
    expect(body.mustChangePassword).toBe(true);
    expect(body.temporaryPassword).toBeTruthy();
    expect(validatePasswordStrength(body.temporaryPassword as string).valid).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.mustChangePassword).toBe(true);

    const relogin = await login(server, TARGET_EMAIL, body.temporaryPassword as string);
    expect(relogin.accessToken).toBeTruthy();
  });

  it("defaults an explicit password to temporary mode", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/users/${target.id}/password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { password: "ExplicitTemp123!" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, mustChangePassword: true });
  });

  it("rejects permanent mode without an explicit password", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/users/${target.id}/password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { mode: "permanent" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a weak explicit password with details", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/users/${target.id}/password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { password: "alllowercasepassword" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { details: string[] };
    expect(body.details.length).toBeGreaterThan(0);
  });

  it("blocks self-reset, unknown targets, and system users", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: USER_ADMIN_EMAIL } });

    const self = await server.inject({
      method: "POST",
      url: `/users/${admin.id}/password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(self.statusCode).toBe(400);

    const missing = await server.inject({
      method: "POST",
      url: "/users/00000000-0000-4000-8000-000000000000/password",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);

    const system = await server.inject({
      method: "POST",
      url: `/users/${systemUser.id}/password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(system.statusCode).toBe(403);
  });

  it("denies a caller without user:admin", async () => {
    const targetTokens = await login(server, TARGET_EMAIL, "ExplicitTemp123!");
    const res = await server.inject({
      method: "POST",
      url: `/users/${secondOwner.id}/password`,
      headers: { authorization: `Bearer ${targetTokens.accessToken}` },
      payload: {},
    });
    // The target has a must-change temp password, so the enforcement hook
    // fires before the permission check — either way it's a 403.
    expect(res.statusCode).toBe(403);
  });

  it("requires owner:all to reset an owner's password", async () => {
    const denied = await server.inject({
      method: "POST",
      url: `/users/${secondOwner.id}/password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);

    const ownerTokens = await login(server, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const allowed = await server.inject({
      method: "POST",
      url: `/users/${secondOwner.id}/password`,
      headers: { authorization: `Bearer ${ownerTokens.accessToken}` },
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("writes an audit row that never contains the password", async () => {
    const rows = await prisma.auditLog.findMany({
      where: { action: "PASSWORD_ADMIN_RESET", userId: target.id },
      orderBy: { createdAt: "desc" },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const serialized = JSON.stringify(row.metadata);
      expect(serialized).not.toContain("ExplicitPerm123!");
      expect(serialized).not.toContain("ExplicitTemp123!");
      expect(row.metadata).toMatchObject({ mode: expect.any(String), generated: expect.any(Boolean) });
    }
  });
});
