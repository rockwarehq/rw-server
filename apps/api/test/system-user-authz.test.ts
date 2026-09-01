import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const ENGINEER_EMAIL = "sys-authz-engineer@test.local";
const SUPPORT_EMAIL = "sys-authz-support@test.local";
const PASSWORD = "sys-authz-password-1";

// Tier 2: Rockware-staff (system-role) users — no WorkspaceMembership by
// design, permissions resolved from code. These logins were previously
// impossible (the session layer was membership-centric).
describe.skipIf(!process.env.TEST_DATABASE_URL)("system-role user authentication & access (Tier 2)", () => {
  let server: TestServer;
  let siteA: { id: string };
  let stationA: { id: string };
  let engineerToken: string;
  let supportToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    siteA = { id: rockware.id };
    stationA = await prisma.station.upsert({
      where: { siteId_name: { siteId: siteA.id, name: "sys-authz-st-a" } },
      update: {},
      create: { name: "sys-authz-st-a", siteId: siteA.id },
      select: { id: true },
    });

    const passwordHash = await hashPassword(PASSWORD);
    for (const { email, systemRole } of [
      { email: ENGINEER_EMAIL, systemRole: "ENGINEER" as const },
      { email: SUPPORT_EMAIL, systemRole: "SUPPORT" as const },
    ]) {
      await prisma.user.upsert({
        where: { email },
        update: { systemRole, passwordHash, status: "ACTIVE" },
        create: { email, passwordHash, systemRole, status: "ACTIVE" },
      });
    }

    engineerToken = (await loginAs(server, ENGINEER_EMAIL, PASSWORD)).accessToken;
    supportToken = (await loginAs(server, SUPPORT_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [ENGINEER_EMAIL, SUPPORT_EMAIL] } } });
    await prisma.station.deleteMany({ where: { id: stationA.id } });
    await server.close();
  });

  it("system users can log in and receive workspace + site context", async () => {
    const me = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${engineerToken}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as {
      workspace: { id: string } | null;
      sites: unknown[];
      access: { roles: Array<{ name: string }>; permissions: string[] };
    };
    expect(body.workspace).not.toBeNull();
    expect(body.sites.length).toBeGreaterThan(0);
    expect(body.access.permissions).toContain("facility:read");
    expect(body.access.roles[0]?.name).toContain("ENGINEER");
  });

  it("ENGINEER can read and write at any site", async () => {
    const read = await rpcCall(server, "station/get", { id: stationA.id }, engineerToken);
    expect(read.statusCode).toBe(200);
    const write = await rpcCall(
      server,
      "station/update",
      { id: stationA.id, description: "sys-authz" },
      engineerToken,
    );
    expect(write.statusCode).toBe(200);
  });

  it("SUPPORT is read-only: reads succeed, writes are denied", async () => {
    const read = await rpcCall(server, "station/get", { id: stationA.id }, supportToken);
    expect(read.statusCode).toBe(200);
    const logs = await rpcCall(server, "logs/cycleSearch", { siteId: siteA.id }, supportToken);
    expect(logs.statusCode).toBe(200);
    const write = await rpcCall(server, "station/update", { id: stationA.id, description: "no" }, supportToken);
    expect(write.statusCode).toBe(403);
  });

  it("neither staff tier reaches settings:admin surfaces", async () => {
    const res = await rpcCall(
      server,
      "integration/delete",
      { id: "00000000-0000-4000-8000-000000000042", siteId: siteA.id },
      supportToken,
    );
    expect(res.statusCode).toBe(403);
  });

  it("system users are hidden from the customer roster", async () => {
    const admin = await loginAs(
      server,
      process.env.TEST_ADMIN_EMAIL ?? "admin@test.local",
      process.env.TEST_ADMIN_PASSWORD ?? "test-password-123",
    );
    const res = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const emails = (res.json() as { users: Array<{ email: string }> }).users.map((u) => u.email);
    expect(emails).not.toContain(ENGINEER_EMAIL);
    expect(emails).not.toContain(SUPPORT_EMAIL);
  });

  it("role assignments to system users remain rejected", async () => {
    const engineer = await prisma.user.findUniqueOrThrow({ where: { email: ENGINEER_EMAIL }, select: { id: true } });
    const { assignments } = await import("@rw/auth/iam/index");
    const rockware = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { workspaceId: true } });
    const role = await prisma.role.findFirstOrThrow({
      where: { workspaceId: rockware.workspaceId, name: "Plant Member" },
      select: { id: true },
    });
    await expect(assignments.assign({ userId: engineer.id, roleId: role.id, siteId: siteA.id })).rejects.toThrow();
  });
});
