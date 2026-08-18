import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const SCOPED_EMAIL = "emp-authz-scoped@test.local";
const NOROLE_EMAIL = "emp-authz-norole@test.local";
const PASSWORD = "emp-authz-password-1";

// Tier 2: people-domain enforcement, especially the anySite rule — employees
// have no site column, so get/update/delete grant when employee:* is held at
// ANY site, while list/create enforce the literal site.
describe.skipIf(!process.env.TEST_DATABASE_URL)("employee domain authorization (Tier 2)", () => {
  let server: TestServer;
  let siteA: { id: string };
  let siteB: { id: string };
  let employee: { id: string };
  let scopedToken: string;
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

    // Employee is a versioned model — the base row only needs a workspaceId.
    employee = await prisma.employee.create({ data: { workspaceId }, select: { id: true } });

    const faRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Factory Administrator", scope: "SITE" } },
      select: { id: true },
    });
    const passwordHash = await hashPassword(PASSWORD);
    for (const { email, roleId } of [
      { email: SCOPED_EMAIL, roleId: faRole.id },
      { email: NOROLE_EMAIL, roleId: undefined },
    ]) {
      const u = await prisma.user.upsert({
        where: { email },
        update: {},
        create: { email, passwordHash, firstName: "EmpAuthZ", status: "ACTIVE" },
      });
      const membership = await prisma.workspaceMembership.upsert({
        where: { userId_workspaceId: { userId: u.id, workspaceId } },
        update: {},
        create: { userId: u.id, workspaceId },
      });
      if (roleId) {
        const existing = await prisma.roleAssignment.findFirst({
          where: { membershipId: membership.id, roleId, siteId: siteA.id },
        });
        if (!existing) {
          await prisma.roleAssignment.create({ data: { membershipId: membership.id, roleId, siteId: siteA.id } });
        }
      }
    }

    scopedToken = (await loginAs(server, SCOPED_EMAIL, PASSWORD)).accessToken;
    noroleToken = (await loginAs(server, NOROLE_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [SCOPED_EMAIL, NOROLE_EMAIL] } } });
    await prisma.employee.deleteMany({ where: { id: employee.id } });
    await prisma.site.deleteMany({ where: { name: "EmpAuthZ Site B" } });
    await server.close();
  });

  it("anySite: a site-scoped employee:read grant allows employee.get", async () => {
    const res = await rpcCall(server, "employee/get", { id: employee.id }, scopedToken);
    expect(res.statusCode).toBe(200);
  });

  it("anySite: zero-grant members are denied on employee.get/update/delete", async () => {
    const get = await rpcCall(server, "employee/get", { id: employee.id }, noroleToken);
    expect(get.statusCode).toBe(403);
    const update = await rpcCall(server, "employee/update", { id: employee.id, firstName: "X" }, noroleToken);
    expect(update.statusCode).toBe(403);
    const del = await rpcCall(server, "employee/delete", { id: employee.id }, noroleToken);
    expect(del.statusCode).toBe(403);
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

  it("employee roles require employee:admin at the target site", async () => {
    const res = await rpcCall(server, "employeeRole/create", { siteId: siteB.id, name: "emp-authz-x" }, scopedToken);
    expect(res.statusCode).toBe(403);
  });
});
