import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlantBucket, makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const SCOPED_EMAIL = "emp-authz-scoped@test.local";
const MANAGER_EMAIL = "emp-authz-manager@test.local";
const NOROLE_EMAIL = "emp-authz-norole@test.local";
const PASSWORD = "emp-authz-password-1";

// Tier 2: people-domain enforcement. Employees are the ADMIN shelf now —
// roster reads AND writes require plant ADMIN. Employees have no site
// column, so get/update/delete grant when ADMIN is held at ANY site, while
// list/create enforce the literal site.
describe.skipIf(!process.env.TEST_DATABASE_URL)("employee domain authorization (Tier 2)", () => {
  let server: TestServer;
  let siteA: { id: string };
  let siteB: { id: string };
  let employee: { id: string };
  let scopedToken: string;
  let managerToken: string;
  let noroleToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    siteA = { id: rockware.id };
    const workspaceId = rockware.workspaceId;
    siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId, name: "EmpAuthZ Site B" } },
      update: {},
      create: { name: "EmpAuthZ Site B", workspaceId },
      select: { id: true },
    });
    await ensurePlantBucket(workspaceId, siteB.id, "EmpAuthZ Site B");

    // Employee is a versioned model — the base row only needs a workspaceId.
    employee = await prisma.employee.create({ data: { workspaceId }, select: { id: true } });

    // Bucket-era fixtures. Employee CRUD actors need plant ADMIN (the
    // scoped user was "Plant Admin" at site A); the manager holds plant
    // MANAGE to prove the people shelf is out of a manager's reach.
    await makeUser(workspaceId, SCOPED_EMAIL, PASSWORD, { plants: [{ siteId: siteA.id, tier: "ADMIN" }] });
    await makeUser(workspaceId, MANAGER_EMAIL, PASSWORD, { plants: [{ siteId: siteA.id, tier: "MANAGE" }] });
    await makeUser(workspaceId, NOROLE_EMAIL, PASSWORD);

    scopedToken = (await loginAs(server, SCOPED_EMAIL, PASSWORD)).accessToken;
    managerToken = (await loginAs(server, MANAGER_EMAIL, PASSWORD)).accessToken;
    noroleToken = (await loginAs(server, NOROLE_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [SCOPED_EMAIL, MANAGER_EMAIL, NOROLE_EMAIL] } } });
    await prisma.employee.deleteMany({ where: { id: employee.id } });
    await prisma.site.deleteMany({ where: { name: "EmpAuthZ Site B" } });
    await server.close();
  });

  it("anySite: plant ADMIN at one site allows employee.get", async () => {
    const res = await rpcCall(server, "employee/get", { id: employee.id }, scopedToken);
    expect(res.statusCode).toBe(200);
  });

  it("anySite: zero-access members are denied on employee.get/update/delete", async () => {
    const get = await rpcCall(server, "employee/get", { id: employee.id }, noroleToken);
    expect(get.statusCode).toBe(403);
    const update = await rpcCall(server, "employee/update", { id: employee.id, firstName: "X" }, noroleToken);
    expect(update.statusCode).toBe(403);
    const del = await rpcCall(server, "employee/delete", { id: employee.id }, noroleToken);
    expect(del.statusCode).toBe(403);
  });

  it("plant MANAGE is denied on the employee roster: people are the ADMIN shelf", async () => {
    // FLIP from the key model: a site writer could read employees; under
    // buckets, roster READS require plant ADMIN too — MANAGE gets 403.
    const get = await rpcCall(server, "employee/get", { id: employee.id }, managerToken);
    expect(get.statusCode).toBe(403);
    const list = await rpcCall(server, "employee/list", { siteId: siteA.id }, managerToken);
    expect(list.statusCode).toBe(403);
    // Writes were never a manager's — still denied.
    const update = await rpcCall(server, "employee/update", { id: employee.id, firstName: "X" }, managerToken);
    expect(update.statusCode).toBe(403);
  });

  it("list/create enforce the literal site: site B is out of scope", async () => {
    const list = await rpcCall(server, "employee/list", { siteId: siteB.id }, scopedToken);
    expect(list.statusCode).toBe(403);
    const create = await rpcCall(
      server,
      "employee/create",
      { siteId: siteB.id, firstName: "No", lastName: "Way" },
      scopedToken,
    );
    expect(create.statusCode).toBe(403);
    const allowed = await rpcCall(server, "employee/list", { siteId: siteA.id }, scopedToken);
    expect(allowed.statusCode).toBe(200);
  });

  it("employee-role management requires plant ADMIN at the target site", async () => {
    const denied = await rpcCall(server, "employeeRole/create", { siteId: siteB.id, name: "emp-authz-x" }, scopedToken);
    expect(denied.statusCode).toBe(403);
    // Plant MANAGE at the right site is still not enough — ADMIN only.
    const manager = await rpcCall(
      server,
      "employeeRole/create",
      { siteId: siteA.id, name: "emp-authz-x" },
      managerToken,
    );
    expect(manager.statusCode).toBe(403);
  });
});
