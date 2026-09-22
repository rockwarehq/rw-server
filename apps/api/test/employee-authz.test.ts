import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const SCOPED_EMAIL = "emp-authz-scoped@test.local";
const NOROLE_EMAIL = "emp-authz-norole@test.local";
const PASSWORD = "emp-authz-password-1";

// Tier 2: employee operations are bound to the administered plant's population.
describe.skipIf(!process.env.TEST_DATABASE_URL)("employee domain authorization (Tier 2)", () => {
  let server: TestServer;
  let siteA: { id: string };
  let siteB: { id: string };
  let employee: { id: string };
  let employeeA: { id: string };
  let roleB: { id: string };
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
      where: { workspaceId_name_scope: { workspaceId, name: "Plant Admin", scope: "SITE" } },
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
    const created = await rpcCall(server, "employee/create", {
      siteId: siteA.id, firstName: "Scoped", lastName: "Employee", pin: "1234",
    }, scopedToken);
    expect(created.statusCode).toBe(200);
    employeeA = created.json as { id: string };
    roleB = await prisma.employeeRole.create({ data: { siteId: siteB.id, name: "EmpAuthZ Operator" }, select: { id: true } });
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [SCOPED_EMAIL, NOROLE_EMAIL] } } });
    await prisma.employee.deleteMany({ where: { id: { in: [employee.id, employeeA.id] } } });
    await prisma.employeeRole.deleteMany({ where: { id: roleB.id } });
    await prisma.site.deleteMany({ where: { name: "EmpAuthZ Site B" } });
    await server.close();
  });

  it("an unrelated employee in the same company is not visible to a plant admin", async () => {
    const res = await rpcCall(server, "employee/get", { id: employee.id, siteId: siteA.id }, scopedToken);
    expect(res.statusCode).toBe(404);
  });

  it("zero-grant members are denied on employee.get/update/delete", async () => {
    const get = await rpcCall(server, "employee/get", { id: employee.id, siteId: siteA.id }, noroleToken);
    expect(get.statusCode).toBe(403);
    const update = await rpcCall(server, "employee/update", { id: employee.id, siteId: siteA.id, firstName: "X" }, noroleToken);
    expect(update.statusCode).toBe(403);
    const del = await rpcCall(server, "employee/delete", { id: employee.id, siteId: siteA.id }, noroleToken);
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

  it("employee roles require plant:admin at the target site", async () => {
    const res = await rpcCall(server, "employeeRole/create", { siteId: siteB.id, name: "emp-authz-x" }, scopedToken);
    expect(res.statusCode).toBe(403);
  });

  it("an admin can read and edit an employee belonging only to its plant", async () => {
    const get = await rpcCall(server, "employee/get", { id: employeeA.id, siteId: siteA.id }, scopedToken);
    expect(get.statusCode).toBe(200);
    const update = await rpcCall(server, "employee/update", { id: employeeA.id, siteId: siteA.id, firstName: "Updated" }, scopedToken);
    expect(update.statusCode).toBe(200);
  });

  it("a role from another plant cannot be used to add access there", async () => {
    const result = await rpcCall(server, "employee/update", { id: employeeA.id, siteId: siteA.id, roleId: roleB.id }, scopedToken);
    expect(result.statusCode).toBe(404);
    expect(await prisma.employeeSiteAccess.findUnique({ where: { employeeId_siteId: { employeeId: employeeA.id, siteId: siteB.id } } })).toBeNull();
  });

  it("shared employee PINs and deletion require authority at every affected plant", async () => {
    await prisma.employeeSiteAccess.create({ data: { employeeId: employeeA.id, siteId: siteB.id, roleId: roleB.id } });
    const update = await rpcCall(server, "employee/update", { id: employeeA.id, siteId: siteA.id, pin: "5678" }, scopedToken);
    expect(update.statusCode).toBe(403);
    const remove = await rpcCall(server, "employee/delete", { id: employeeA.id, siteId: siteA.id }, scopedToken);
    expect(remove.statusCode).toBe(403);
    const get = await rpcCall(server, "employee/get", { id: employeeA.id, siteId: siteA.id }, scopedToken);
    expect(get.statusCode).toBe(200);
    expect((get.json as { siteAccess: Array<{ siteId: string }> }).siteAccess.map((access) => access.siteId)).toEqual([siteA.id]);
  });
});
