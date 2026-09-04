import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const FA_EMAIL = "rep-authz-fa@test.local";
const READER_EMAIL = "rep-authz-reader@test.local";
const PASSWORD = "rep-authz-password-1";

// Tier 2: reporting surface (logs.ts + shift-recap.ts, ADR-0002 direct-Prisma
// routers). These previously had zero authorization.
describe.skipIf(!process.env.TEST_DATABASE_URL)("reporting domain authorization (Tier 2)", () => {
  let server: TestServer;
  let siteA: { id: string };
  let siteB: { id: string };
  let stationB: { id: string };
  let commentB: { id: string };
  let faToken: string;
  let readerToken: string;

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
      where: { workspaceId_name: { workspaceId, name: "RepAuthZ Site B" } },
      update: {},
      create: { name: "RepAuthZ Site B", workspaceId },
      select: { id: true },
    });
    stationB = await prisma.station.upsert({
      where: { siteId_name: { siteId: siteB.id, name: "rep-authz-st-b" } },
      update: {},
      create: { name: "rep-authz-st-b", siteId: siteB.id },
      select: { id: true },
    });
    const wcB = await (async () => {
      const existing = await prisma.workcenter.findFirst({
        where: { siteId: siteB.id, name: "rep-authz-wc-b" },
        select: { id: true },
      });
      return existing ?? prisma.workcenter.create({ data: { name: "rep-authz-wc-b", siteId: siteB.id }, select: { id: true } });
    })();
    // ShiftInstance needs a pattern/definition/assignment chain; borrow any
    // existing instance for the FK — the policy resolver reads the COMMENT's
    // siteId, which is what the cross-site test exercises.
    const anyShift = await prisma.shiftInstance.findFirstOrThrow({ select: { id: true } });
    commentB = await prisma.shiftComment.create({
      data: {
        siteId: siteB.id,
        shiftInstanceId: anyShift.id,
        workcenterId: wcB.id,
        text: "rep-authz-comment",
      },
      select: { id: true },
    });

    const faRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Plant Admin", scope: "SITE" } },
      select: { id: true },
    });
    const readerRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Plant Member", scope: "SITE" } },
      select: { id: true },
    });
    const passwordHash = await hashPassword(PASSWORD);
    for (const { email, roleId } of [
      { email: FA_EMAIL, roleId: faRole.id },
      { email: READER_EMAIL, roleId: readerRole.id },
    ]) {
      const u = await prisma.user.upsert({
        where: { email },
        update: {},
        create: { email, passwordHash, firstName: "RepAuthZ", status: "ACTIVE" },
      });
      const membership = await prisma.workspaceMembership.upsert({
        where: { userId_workspaceId: { userId: u.id, workspaceId } },
        update: {},
        create: { userId: u.id, workspaceId },
      });
      const existing = await prisma.roleAssignment.findFirst({
        where: { membershipId: membership.id, roleId, siteId: siteA.id },
      });
      if (!existing) {
        await prisma.roleAssignment.create({ data: { membershipId: membership.id, roleId, siteId: siteA.id } });
      }
    }

    faToken = (await loginAs(server, FA_EMAIL, PASSWORD)).accessToken;
    readerToken = (await loginAs(server, READER_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [FA_EMAIL, READER_EMAIL] } } });
    await prisma.shiftComment.deleteMany({ where: { siteId: siteB.id } });
    await prisma.shiftInstance.deleteMany({ where: { siteId: siteB.id } });
    await prisma.station.deleteMany({ where: { siteId: siteB.id } });
    await prisma.workcenter.deleteMany({ where: { siteId: siteB.id } });
    await prisma.site.deleteMany({ where: { name: "RepAuthZ Site B" } });
    await server.close();
  });

  it("log searches deny out-of-scope sites", async () => {
    const cycles = await rpcCall(server, "logs/cycleSearch", { siteId: siteB.id }, faToken);
    expect(cycles.statusCode).toBe(403);
    const downtime = await rpcCall(server, "logs/downtimeSearch", { siteId: siteB.id }, faToken);
    expect(downtime.statusCode).toBe(403);
  });

  it("log searches allow the granted site and honor permission mapping", async () => {
    const cycles = await rpcCall(server, "logs/cycleSearch", { siteId: siteA.id }, faToken);
    expect(cycles.statusCode).toBe(200);
    // Plant Member carries employee:read, so logon search is permitted
    const logon = await rpcCall(server, "logs/logonSearch", { siteId: siteA.id }, readerToken);
    expect(logon.statusCode).toBe(200);
  });

  it("a cross-site stationId probe on an authorized site returns no foreign data", async () => {
    const res = await rpcCall(
      server,
      "logs/downtimeSearch",
      { siteId: siteA.id, stationId: stationB.id },
      faToken,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json as { data: unknown[] }).data).toEqual([]);
  });

  it("shift-recap reads deny out-of-scope sites before any lookup", async () => {
    const res = await rpcCall(
      server,
      "shiftRecap/shiftInstances",
      { siteId: siteB.id, workCenterId: stationB.id, businessDate: "2026-01-01" },
      faToken,
    );
    expect(res.statusCode).toBe(403);
  });

  it("shift comments cannot be tampered with across the site boundary", async () => {
    const update = await rpcCall(server, "shiftRecap/commentUpdate", { id: commentB.id, text: "hacked" }, faToken);
    expect(update.statusCode).toBe(403);
    const del = await rpcCall(server, "shiftRecap/commentDelete", { id: commentB.id }, faToken);
    expect(del.statusCode).toBe(403);
  });

  it("read-only users cannot write shift comments in their own site", async () => {
    const res = await rpcCall(
      server,
      "shiftRecap/commentCreate",
      {
        siteId: siteA.id,
        shiftInstanceId: commentB.id,
        workCenterId: stationB.id,
        text: "no",
      },
      readerToken,
    );
    expect(res.statusCode).toBe(403);
  });
});
