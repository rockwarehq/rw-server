import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { createAccessToken } from "@rw/auth/verify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

// operator.employees carries each person's active role at the display's site
// — the role a call's or mode's allowed roles are checked against — so the
// terminal can list the people who may act first.

describe.skipIf(!process.env.TEST_DATABASE_URL)("operator.employees roles", () => {
  let server: TestServer;
  let token: string;
  let displayId: string;
  let operatorRoleId: string;
  let maintenanceRoleId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const suffix = randomUUID();
    // One workspace per deployment: use it.
    const workspace = await prisma.workspace.findFirstOrThrow();
    const site = await prisma.site.create({ data: { name: `Site ${suffix}`, workspaceId: workspace.id } });
    const otherSite = await prisma.site.create({ data: { name: `Other ${suffix}`, workspaceId: workspace.id } });
    operatorRoleId = (await prisma.employeeRole.create({ data: { name: `Ops ${suffix}`, siteId: site.id } })).id;
    maintenanceRoleId = (await prisma.employeeRole.create({ data: { name: `Maint ${suffix}`, siteId: site.id } }))
      .id;
    const elsewhereRoleId = (
      await prisma.employeeRole.create({ data: { name: `Elsewhere ${suffix}`, siteId: otherSite.id } })
    ).id;

    const employee = async (firstName: string, access: Array<{ siteId: string; roleId: string }>) => {
      const { id } = await prisma.employee.create({ data: { workspaceId: workspace.id }, select: { id: true } });
      const version = await prisma.employeeVersion.create({
        data: { employeeId: id, version: 1, firstName, lastName: suffix },
      });
      await prisma.employee.update({ where: { id }, data: { versionId: version.id } });
      for (const row of access) await prisma.employeeSiteAccess.create({ data: { employeeId: id, ...row } });
      ids[firstName] = id;
    };
    await employee("Olive", [{ siteId: site.id, roleId: operatorRoleId }]);
    // Maintenance here, and a role at another site that must not leak in.
    await employee("Milo", [
      { siteId: site.id, roleId: maintenanceRoleId },
      { siteId: otherSite.id, roleId: elsewhereRoleId },
    ]);

    displayId = (await prisma.display.create({ data: { status: "CLAIMED", siteId: site.id, claimedAt: new Date() } }))
      .id;
    token = createAccessToken({ principal: "DISPLAY", displayId, siteId: site.id, workspaceId: workspace.id });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("gives each person their role at this site", async () => {
    const res = await rpcCall(server, "operator/employees", { displayId }, token);

    expect(res.statusCode).toBe(200);
    const rows = res.json as Array<{ id: string; roleId: string | null }>;
    const roleOf = (name: string) => rows.find((row) => row.id === ids[name])?.roleId;
    expect(roleOf("Olive")).toBe(operatorRoleId);
    expect(roleOf("Milo")).toBe(maintenanceRoleId);
  });
});
