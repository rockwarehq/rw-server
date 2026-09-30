import prisma from "@rw/db";
import { seedDefaults } from "@rw/services/employee/role";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { update as updateUser } from "../src/services/account/user/crud.js";
import { removeMember, removeSiteAccess } from "../src/services/account/workspace/members.js";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./global-setup.js";
import { plantBucketId } from "./helpers/access.js";
import { buildServer, type TestServer } from "./helpers/build-server.js";

// Every account is on its plants' teams: invites and access changes make and
// link the person's team member (Employee) with a team role per plant.

const EMAILS = {
  picked: "team-picked@test.local",
  byLevel: "team-by-level@test.local",
  wrongPlant: "team-wrong-plant@test.local",
  floor: "team-floor-operator@test.local",
  revoked: "team-revoked@test.local",
};
const SITE_B = "Account Team Site B";

let ipTail = 1;
function nextIp(): string {
  return `10.98.0.${ipTail++}`;
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { in: Object.values(EMAILS) } },
    select: { id: true, employeeId: true },
  });
  await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  const employeeIds = users.map((u) => u.employeeId).filter((id): id is string => !!id);
  const floor = await prisma.employee.findMany({
    where: { version: { is: { email: { equals: EMAILS.floor, mode: "insensitive" } } } },
    select: { id: true },
  });
  await prisma.employee.deleteMany({ where: { id: { in: [...employeeIds, ...floor.map((e) => e.id)] } } });
}

async function teamOf(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: {
      employee: {
        select: {
          id: true,
          status: true,
          version: { select: { firstName: true, lastName: true, email: true, badgeNumber: true } },
          siteAccess: { select: { siteId: true, status: true, role: { select: { name: true } } } },
        },
      },
    },
  });
  return user.employee;
}

// Tier 2: needs a migrated + seeded Postgres (TEST_DATABASE_URL).
describe.skipIf(!process.env.TEST_DATABASE_URL)("account team members (Tier 2)", () => {
  let server: TestServer;
  let workspaceId: string;
  let siteA: string;
  let siteB: string;
  let bucketA: string;
  let bucketB: string;
  let adminToken: string;

  function invite(payload: Record<string, unknown>) {
    return server.inject({
      method: "POST",
      url: "/users/invite",
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
      remoteAddress: nextIp(),
    });
  }

  function setAccess(userId: string, payload: Record<string, unknown>) {
    return server.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/members/${userId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
      remoteAddress: nextIp(),
    });
  }

  async function roleId(siteId: string, name: string) {
    const role = await prisma.employeeRole.findUniqueOrThrow({ where: { siteId_name: { siteId, name } } });
    return role.id;
  }

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    await cleanup();

    workspaceId = (await prisma.workspace.findFirstOrThrow()).id;
    siteA = (await prisma.site.findFirstOrThrow({ where: { workspaceId, name: "Rockware" } })).id;
    const b = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId, name: SITE_B } },
      update: {},
      create: { name: SITE_B, workspaceId, buckets: { create: { workspaceId, kind: "PLANT", name: SITE_B } } },
    });
    siteB = b.id;
    await seedDefaults(siteB);
    bucketA = await plantBucketId(siteA);
    bucketB = await plantBucketId(siteB);

    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD },
      remoteAddress: nextIp(),
    });
    expect(login.statusCode).toBe(200);
    adminToken = login.json<{ accessToken: string }>().accessToken;
  });

  afterAll(async () => {
    await cleanup();
    await server.close();
  });

  it("an invite puts the invitee on the plant's team with the picked role", async () => {
    const res = await invite({
      email: EMAILS.picked,
      firstName: "Morgan",
      lastName: "Picked",
      bucketAccesses: [{ bucketId: bucketA, level: "VIEW" }],
      employeeRoleId: await roleId(siteA, "Maintenance"),
    });
    expect(res.statusCode).toBe(201);

    const team = await teamOf(EMAILS.picked);
    expect(team?.status).toBe("ACTIVE");
    expect(team?.version).toMatchObject({ firstName: "Morgan", lastName: "Picked", email: EMAILS.picked });
    expect(team?.siteAccess).toEqual([{ siteId: siteA, status: "ACTIVE", role: { name: "Maintenance" } }]);
  });

  it("without a pick, the role follows the access level", async () => {
    const res = await invite({
      email: EMAILS.byLevel,
      bucketAccesses: [{ bucketId: bucketA, level: "MANAGE" }],
    });
    expect(res.statusCode).toBe(201);

    const team = await teamOf(EMAILS.byLevel);
    // No name on the invite: named after the email.
    expect(team?.version?.firstName).toBe("team-by-level");
    expect(team?.siteAccess.map((a) => a.role.name)).toEqual(["Supervisor"]);
  });

  it("refuses a team role from a plant the invite doesn't grant", async () => {
    const res = await invite({
      email: EMAILS.wrongPlant,
      bucketAccesses: [{ bucketId: bucketA, level: "VIEW" }],
      employeeRoleId: await roleId(siteB, "Operator"),
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { email: EMAILS.wrongPlant } })).toBeNull();
  });

  it("access at another plant adds that plant's team role, and losing it deactivates only that one", async () => {
    const { id: userId } = await prisma.user.findUniqueOrThrow({ where: { email: EMAILS.byLevel } });

    // MANAGE, not ADMIN: the last plant admin can't be removed further down.
    expect((await setAccess(userId, { set: [{ bucketId: bucketB, level: "MANAGE" }] })).statusCode).toBe(200);
    let team = await teamOf(EMAILS.byLevel);
    expect(team?.siteAccess).toEqual(
      expect.arrayContaining([
        { siteId: siteA, status: "ACTIVE", role: { name: "Supervisor" } },
        { siteId: siteB, status: "ACTIVE", role: { name: "Supervisor" } },
      ]),
    );

    // Re-granting at a lower level never downgrades the plant's choice.
    expect((await setAccess(userId, { set: [{ bucketId: bucketA, level: "VIEW" }] })).statusCode).toBe(200);

    expect((await removeSiteAccess(userId, siteB)).success).toBe(true);
    team = await teamOf(EMAILS.byLevel);
    expect(team?.siteAccess).toEqual(
      expect.arrayContaining([
        { siteId: siteA, status: "ACTIVE", role: { name: "Supervisor" } },
        { siteId: siteB, status: "INACTIVE", role: { name: "Supervisor" } },
      ]),
    );

    // Coming back to the plant reactivates their old role.
    expect((await setAccess(userId, { set: [{ bucketId: bucketB, level: "VIEW" }] })).statusCode).toBe(200);
    team = await teamOf(EMAILS.byLevel);
    expect(team?.siteAccess.find((a) => a.siteId === siteB)).toEqual({
      siteId: siteB,
      status: "ACTIVE",
      role: { name: "Supervisor" },
    });
  });

  it("a rename carries to the team profile", async () => {
    const { id: userId } = await prisma.user.findUniqueOrThrow({ where: { email: EMAILS.byLevel } });
    await updateUser(userId, { firstName: "Robin", lastName: "Level" });
    expect((await teamOf(EMAILS.byLevel))?.version).toMatchObject({ firstName: "Robin", lastName: "Level" });
  });

  it("removing someone from the account takes them off every team, keeping the profile", async () => {
    const { id: userId } = await prisma.user.findUniqueOrThrow({ where: { email: EMAILS.byLevel } });
    expect((await removeMember(userId)).success).toBe(true);
    const team = await teamOf(EMAILS.byLevel);
    expect(team?.status).toBe("INACTIVE");
    expect(team?.siteAccess.every((a) => a.status === "INACTIVE")).toBe(true);
  });

  it("inviting someone already on the floor team links their existing team member", async () => {
    const operator = await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({ data: { workspaceId, status: "ACTIVE" } });
      const version = await tx.employeeVersion.create({
        data: {
          employeeId: employee.id,
          version: 1,
          firstName: "Flo",
          lastName: "Floor",
          email: EMAILS.floor.toUpperCase(),
          badgeNumber: "TEAM-B-1",
        },
      });
      await tx.employee.update({ where: { id: employee.id }, data: { versionId: version.id } });
      await tx.employeeSiteAccess.create({
        data: { employeeId: employee.id, siteId: siteA, roleId: await roleId(siteA, "Quality"), status: "ACTIVE" },
      });
      return employee;
    });

    const res = await invite({ email: EMAILS.floor, bucketAccesses: [{ bucketId: bucketA, level: "MANAGE" }] });
    expect(res.statusCode).toBe(201);
    const team = await teamOf(EMAILS.floor);
    expect(team?.id).toBe(operator.id);
    // Their plant role stays; access level only picks roles for new placements.
    expect(team?.siteAccess.map((a) => a.role.name)).toEqual(["Quality"]);

    // Revoking the invite unlinks them but never deletes a real team member.
    const { id: userId } = await prisma.user.findUniqueOrThrow({ where: { email: EMAILS.floor } });
    const revoke = await server.inject({
      method: "DELETE",
      url: `/users/invite/${userId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: nextIp(),
    });
    expect(revoke.statusCode).toBeLessThan(300);
    expect(await prisma.employee.findUnique({ where: { id: operator.id } })).not.toBeNull();
  });

  it("revoking an invite deletes the profile it made", async () => {
    expect(
      (await invite({ email: EMAILS.revoked, bucketAccesses: [{ bucketId: bucketA, level: "VIEW" }] })).statusCode,
    ).toBe(201);
    const { id: userId, employeeId } = await prisma.user.findUniqueOrThrow({ where: { email: EMAILS.revoked } });
    expect(employeeId).toBeTruthy();

    const revoke = await server.inject({
      method: "DELETE",
      url: `/users/invite/${userId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: nextIp(),
    });
    expect(revoke.statusCode).toBeLessThan(300);
    expect(await prisma.employee.findUnique({ where: { id: employeeId! } })).toBeNull();
  });
});
