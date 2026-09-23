import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const ENGINEER_EMAIL = "sys-authz-engineer@test.local";
const SUPPORT_EMAIL = "sys-authz-support@test.local";
const PASSWORD = "sys-authz-password-1";

// Tier 2: Rockware-staff (system-role) users — no WorkspaceMembership by
// design, standing resolved from code: SUPPORT reads everywhere, ENGINEER
// manages everywhere, neither reaches ownership-only actions.
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
      access: { isAccountAdmin: boolean; staff: string; buckets: unknown[] };
    };
    expect(body.workspace).not.toBeNull();
    expect(body.sites.length).toBeGreaterThan(0);
    expect(body.access.staff).toBe("FULL");
    expect(body.access.isAccountAdmin).toBe(false);
    expect(body.access.buckets).toEqual([]);
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

  it("staff bypasses stop where they should: SUPPORT at MANAGE, ENGINEER at ownership", async () => {
    const supportCreate = await rpcCall(
      server,
      "workcenter/create",
      { siteId: siteA.id, name: "support-cannot-create" },
      supportToken,
    );
    expect(supportCreate.statusCode).toBe(403);

    // A second workspace can't exist at all: the route is gone.
    const createWorkspace = await server.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${engineerToken}` },
      payload: { name: "sys-authz-ws-never" },
    });
    expect(createWorkspace.statusCode).toBe(404);
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

  it("system users hold no bucket accesses and are not account admins; standing comes from code", async () => {
    const accesses = await prisma.bucketAccess.count({
      where: { user: { email: { in: [ENGINEER_EMAIL, SUPPORT_EMAIL] } } },
    });
    expect(accesses).toBe(0);
    const admins = await prisma.user.count({
      where: { email: { in: [ENGINEER_EMAIL, SUPPORT_EMAIL] }, isAccountAdmin: true },
    });
    expect(admins).toBe(0);

    const supportMe = await server.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(supportMe.statusCode).toBe(200);
    const supportAccess = (supportMe.json() as { access: { staff: string; buckets: unknown[] } }).access;
    expect(supportAccess.staff).toBe("READ");
    expect(supportAccess.buckets).toEqual([]);

    // ENGINEER acts everywhere: the admin-gated roster answers.
    const engineerRoster = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${engineerToken}` },
    });
    expect(engineerRoster.statusCode).toBe(200);

    // SUPPORT is read-only: the roster is an ADMIN surface (403), and
    // mutations like inviting are denied.
    const supportRoster = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(supportRoster.statusCode).toBe(403);

    const bucket = await prisma.bucket.findFirstOrThrow({
      where: { siteId: siteA.id, kind: "PLANT" },
      select: { id: true },
    });
    const invite = await server.inject({
      method: "POST",
      url: "/users/invite",
      headers: { authorization: `Bearer ${supportToken}` },
      payload: { email: "sys-authz-nope@test.local", bucketAccesses: [{ bucketId: bucket.id, level: "VIEW" }] },
    });
    expect(invite.statusCode).toBe(403);
  });
});
