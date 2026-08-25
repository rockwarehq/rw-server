import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const FLAGGED_EMAIL = "must-change@test.local";
const TEMP_PASSWORD = "TempPassword123!";
const FINAL_PASSWORD = "FinalPassword456!";
const ROLE_NAME = "Test User Admin (must change)";

let ipTail = 1;
function nextIp(): string {
  return `10.97.0.${ipTail++}`;
}

// Tier 2: needs a migrated + seeded Postgres (TEST_DATABASE_URL).
describe.skipIf(!process.env.TEST_DATABASE_URL)("mustChangePassword enforcement (Tier 2)", () => {
  let server: TestServer;
  let tokens: { accessToken: string; refreshToken: string };

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });
    // Role with enough permissions that a blocked request can only be
    // explained by the must-change gate, not by missing permissions.
    const role = await prisma.role.create({
      data: {
        workspaceId: workspace.id,
        name: ROLE_NAME,
        scope: "WORKSPACE",
        permissions: ["user:read", "user:write", "user:admin"],
        isSystem: false,
      },
    });

    const passwordHash = await hashPassword(TEMP_PASSWORD);
    const user = await prisma.user.create({
      data: { email: FLAGGED_EMAIL, passwordHash, status: "ACTIVE", mustChangePassword: true },
    });
    const membership = await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: workspace.id },
    });
    await prisma.roleAssignment.create({
      data: { membershipId: membership.id, roleId: role.id, siteId: null },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: FLAGGED_EMAIL } });
    await prisma.role.deleteMany({ where: { name: ROLE_NAME } });
    await server.close();
  });

  it("login succeeds and reports mustChangePassword", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: FLAGGED_EMAIL, password: TEMP_PASSWORD },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { mustChangePassword: boolean }; accessToken: string; refreshToken: string };
    expect(body.user.mustChangePassword).toBe(true);
    tokens = body;
  });

  it("blocks REST routes outside the allowlist with a distinct code", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "password_change_required" });
  });

  it("blocks RPC procedures", async () => {
    const res = await rpcCall(server, "workspace/listMembers", {}, tokens.accessToken);
    expect(res.statusCode).toBe(403);
  });

  it("still allows profile, refresh, and the password change itself", async () => {
    const me = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(true);

    const refresh = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
      remoteAddress: nextIp(),
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(refresh.statusCode).toBe(200);
    tokens.refreshToken = (refresh.json() as { refreshToken: string }).refreshToken;

    const change = await server.inject({
      method: "PUT",
      url: "/users/me/password",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { currentPassword: TEMP_PASSWORD, newPassword: FINAL_PASSWORD },
      remoteAddress: nextIp(),
    });
    expect(change.statusCode).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { email: FLAGGED_EMAIL } });
    expect(row.mustChangePassword).toBe(false);
  });

  it("unblocks previously rejected routes once the password is changed", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows logout while flagged", async () => {
    // Re-flag and take a fresh session to prove logout passes the gate
    await prisma.user.update({ where: { email: FLAGGED_EMAIL }, data: { mustChangePassword: true } });
    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: FLAGGED_EMAIL, password: FINAL_PASSWORD },
      remoteAddress: nextIp(),
    });
    expect(login.statusCode).toBe(200);
    const fresh = login.json() as { accessToken: string; refreshToken: string };

    const logout = await server.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken: fresh.refreshToken },
      headers: { authorization: `Bearer ${fresh.accessToken}` },
      remoteAddress: nextIp(),
    });
    expect(logout.statusCode).toBe(200);
  });
});
