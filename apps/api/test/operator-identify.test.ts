import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { createAccessToken } from "@rw/auth/verify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

// operator.identify: prove who is acting at a terminal without logging them
// on. The failure it exists to prevent — a supervisor approving a call under
// single logon and thereby ending the machine operator's session — is
// asserted directly, alongside logon doing exactly that.

describe.skipIf(!process.env.TEST_DATABASE_URL)("operator.identify", () => {
  let server: TestServer;
  let token: string;
  let displayId: string;
  let stationId: string;
  let operatorId: string;
  let supervisorId: string;

  const activeSessions = () =>
    prisma.stationLogonSession.findMany({ where: { displayId, logoffTime: null }, select: { employeeId: true } });

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({
      data: { name: `Identify ${suffix}`, slug: `identify-${suffix}` },
    });
    // Single logon, site-wide: logon ends whoever is on the station.
    const site = await prisma.site.create({
      data: { name: `Site ${suffix}`, workspaceId: workspace.id, attrs: { operatorLogon: { multiLogon: false } } },
    });
    const workcenter = await prisma.workcenter.create({ data: { name: `WC ${suffix}`, siteId: site.id } });
    stationId = (
      await prisma.station.create({ data: { name: `STN ${suffix}`, siteId: site.id, workcenterId: workcenter.id } })
    ).id;
    const role = await prisma.employeeRole.create({ data: { name: `Ops ${suffix}`, siteId: site.id } });

    const employee = async (firstName: string, pin: string) => {
      const { id } = await prisma.employee.create({ data: { workspaceId: workspace.id }, select: { id: true } });
      const version = await prisma.employeeVersion.create({
        data: { employeeId: id, version: 1, firstName, lastName: "Test", pinHash: await hashPassword(pin) },
      });
      await prisma.employee.update({ where: { id }, data: { versionId: version.id } });
      await prisma.employeeSiteAccess.create({ data: { employeeId: id, siteId: site.id, roleId: role.id } });
      return id;
    };
    operatorId = await employee("Operator", "1111");
    supervisorId = await employee("Supervisor", "2222");

    const display = await prisma.display.create({
      data: { status: "CLAIMED", siteId: site.id, claimedAt: new Date() },
    });
    displayId = display.id;
    token = createAccessToken({
      principal: "DISPLAY",
      displayId,
      siteId: site.id,
      workspaceId: workspace.id,
    });

    // The machine's operator is on.
    const logon = await rpcCall(
      server,
      "operator/logon",
      { displayId, stationId, method: "EMPLOYEE_ID", credentials: { employeeId: operatorId } },
      token,
    );
    expect(logon.statusCode).toBe(200);
  });

  afterAll(async () => {
    await server?.close();
  });

  const identify = (method: string, credentials: Record<string, string>) =>
    rpcCall(server, "operator/identify", { displayId, stationId, method, credentials }, token);

  it("names the employee and leaves the operator logged on", async () => {
    const res = await identify("PIN", { employeeId: supervisorId, pin: "2222" });

    expect(res.statusCode).toBe(200);
    expect((res.json as { employeeId: string }).employeeId).toBe(supervisorId);
    // No session for the supervisor, and the operator's is untouched.
    expect(await activeSessions()).toEqual([{ employeeId: operatorId }]);
  });

  it("refuses a wrong PIN and counts it toward lockout, as logon does", async () => {
    const res = await identify("PIN", { employeeId: supervisorId, pin: "9999" });

    expect(res.statusCode).toBe(403);
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: supervisorId } });
    expect(employee.failedLoginAttempts).toBe(1);
    expect(await activeSessions()).toEqual([{ employeeId: operatorId }]);
  });

  it("takes no generic name — a typed name identifies no one", async () => {
    const res = await identify("GENERIC", { genericName: "Somebody" });

    expect(res.statusCode).toBe(400);
  });

  it("does not create an employee for an unknown badge", async () => {
    const before = await prisma.employee.count();
    const res = await identify("BADGE", { badgeNumber: `UNKNOWN-${randomUUID()}` });

    expect(res.statusCode).toBe(403);
    expect(await prisma.employee.count()).toBe(before);
  });

  it("is what logon is not: logon under single logon ends the operator's session", async () => {
    const res = await rpcCall(
      server,
      "operator/logon",
      { displayId, stationId, method: "PIN", credentials: { employeeId: supervisorId, pin: "2222" } },
      token,
    );

    expect(res.statusCode).toBe(200);
    expect(await activeSessions()).toEqual([{ employeeId: supervisorId }]);
  });
});
