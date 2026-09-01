import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { user as userService, workspace as workspaceService } from "../src/services/account/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const PREFIX = "wcgrant";
const WRITE_EMAIL = "wcgrant-write@test.local";
const READ_EMAIL = "wcgrant-read@test.local";
const PLANT_ADMIN_EMAIL = "wcgrant-pa@test.local";
const INVITEE_EMAIL = "wcgrant-invitee@test.local";
const PASSWORD = "wcgrant-password-1";
const EMAILS = [WRITE_EMAIL, READ_EMAIL, PLANT_ADMIN_EMAIL, INVITEE_EMAIL];

// Tier 2: workcenter grants end to end. A user with only a WorkcenterGrant
// (zero RoleAssignments) can enter the plant, read global data site-wide,
// write within their workcenter, and nothing more; plant admins manage
// grants for their own plant only.
describe.skipIf(!process.env.TEST_DATABASE_URL)("workcenter grant authorization (Tier 2)", () => {
  let server: TestServer;
  let workspaceId: string;
  let siteA: { id: string };
  let siteB: { id: string };
  let wcGranted: { id: string };
  let wcOther: { id: string };
  let wcSiteB: { id: string };
  let stationGranted: { id: string };
  let stationOther: { id: string };
  let stationNoWc: { id: string };
  let writeUserId: string;
  let writeToken: string;
  let readToken: string;
  let plantAdminToken: string;
  let companyAdminToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    siteA = { id: rockware.id };
    workspaceId = rockware.workspaceId;
    siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId, name: `${PREFIX} Site B` } },
      update: {},
      create: { name: `${PREFIX} Site B`, workspaceId },
      select: { id: true },
    });

    const findOrCreateWorkcenter = async (siteId: string, name: string) => {
      const existing = await prisma.workcenter.findFirst({ where: { siteId, name }, select: { id: true } });
      return existing ?? prisma.workcenter.create({ data: { name, siteId }, select: { id: true } });
    };
    wcGranted = await findOrCreateWorkcenter(siteA.id, `${PREFIX}-wc-granted`);
    wcOther = await findOrCreateWorkcenter(siteA.id, `${PREFIX}-wc-other`);
    wcSiteB = await findOrCreateWorkcenter(siteB.id, `${PREFIX}-wc-b`);

    const findOrCreateStation = async (siteId: string, name: string, workcenterId: string | null) =>
      prisma.station.upsert({
        where: { siteId_name: { siteId, name } },
        update: { deletedAt: null, workcenterId },
        create: { name, siteId, workcenterId },
        select: { id: true },
      });
    stationGranted = await findOrCreateStation(siteA.id, `${PREFIX}-st-granted`, wcGranted.id);
    stationOther = await findOrCreateStation(siteA.id, `${PREFIX}-st-other`, wcOther.id);
    stationNoWc = await findOrCreateStation(siteA.id, `${PREFIX}-st-nowc`, null);

    const plantAdminRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Plant Admin", scope: "SITE" } },
      select: { id: true },
    });

    const passwordHash = await hashPassword(PASSWORD);
    const makeMember = async (email: string) => {
      const u = await prisma.user.upsert({
        where: { email },
        update: { passwordHash, status: "ACTIVE" },
        create: { email, passwordHash, firstName: "WcGrant", status: "ACTIVE" },
      });
      const membership = await prisma.workspaceMembership.upsert({
        where: { userId_workspaceId: { userId: u.id, workspaceId } },
        update: {},
        create: { userId: u.id, workspaceId },
      });
      return { userId: u.id, membershipId: membership.id };
    };

    // WRITE and READ users hold ONLY a workcenter grant — no role assignments.
    const writer = await makeMember(WRITE_EMAIL);
    writeUserId = writer.userId;
    await prisma.workcenterGrant.upsert({
      where: { membershipId_workcenterId: { membershipId: writer.membershipId, workcenterId: wcGranted.id } },
      update: { access: "WRITE" },
      create: { membershipId: writer.membershipId, workcenterId: wcGranted.id, access: "WRITE" },
    });
    const reader = await makeMember(READ_EMAIL);
    await prisma.workcenterGrant.upsert({
      where: { membershipId_workcenterId: { membershipId: reader.membershipId, workcenterId: wcGranted.id } },
      update: { access: "READ" },
      create: { membershipId: reader.membershipId, workcenterId: wcGranted.id, access: "READ" },
    });

    const plantAdmin = await makeMember(PLANT_ADMIN_EMAIL);
    const existingAssignment = await prisma.roleAssignment.findFirst({
      where: { membershipId: plantAdmin.membershipId, roleId: plantAdminRole.id, siteId: siteA.id },
    });
    if (!existingAssignment) {
      await prisma.roleAssignment.create({
        data: { membershipId: plantAdmin.membershipId, roleId: plantAdminRole.id, siteId: siteA.id },
      });
    }

    writeToken = (await loginAs(server, WRITE_EMAIL, PASSWORD)).accessToken;
    readToken = (await loginAs(server, READ_EMAIL, PASSWORD)).accessToken;
    plantAdminToken = (await loginAs(server, PLANT_ADMIN_EMAIL, PASSWORD)).accessToken;
    companyAdminToken = (
      await loginAs(
        server,
        process.env.TEST_ADMIN_EMAIL ?? "admin@test.local",
        process.env.TEST_ADMIN_PASSWORD ?? "test-password-123",
      )
    ).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
    const jobIds = (
      await prisma.job.findMany({ where: { versions: { some: { name: { startsWith: PREFIX } } } }, select: { id: true } })
    ).map((j) => j.id);
    await prisma.job.updateMany({ where: { id: { in: jobIds } }, data: { currentVersionId: null } });
    await prisma.jobVersion.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.station.deleteMany({ where: { name: { startsWith: `${PREFIX}-st` } } });
    await prisma.workcenter.deleteMany({ where: { name: { startsWith: `${PREFIX}-wc` } } });
    await prisma.site.deleteMany({ where: { name: `${PREFIX} Site B` } });
    await server.close();
  });

  describe("workcenter-only users (no role assignments)", () => {
    it("login binds the grant's site and global reads work site-wide", async () => {
      const jobs = await rpcCall(server, "job/list", { siteId: siteA.id }, readToken);
      expect(jobs.statusCode).toBe(200);
      const stations = await rpcCall(server, "station/list", { siteId: siteA.id }, readToken);
      expect(stations.statusCode).toBe(200);
      const products = await rpcCall(server, "product/list", { siteId: siteA.id }, writeToken);
      expect(products.statusCode).toBe(200);
    });

    it("WRITE grant writes global resources site-wide", async () => {
      const created = await rpcCall(server, "job/create", { siteId: siteA.id, name: `${PREFIX}-job-1` }, writeToken);
      expect(created.statusCode).toBe(200);
    });

    it("READ grant cannot write anything", async () => {
      const job = await rpcCall(server, "job/create", { siteId: siteA.id, name: `${PREFIX}-job-nope` }, readToken);
      expect(job.statusCode).toBe(403);
      const station = await rpcCall(server, "station/update", { id: stationGranted.id, description: "no" }, readToken);
      expect(station.statusCode).toBe(403);
    });

    it("WRITE grant configures stations only inside its workcenter", async () => {
      const own = await rpcCall(
        server,
        "station/update",
        { id: stationGranted.id, description: `${PREFIX} updated` },
        writeToken,
      );
      expect(own.statusCode).toBe(200);

      const other = await rpcCall(server, "station/update", { id: stationOther.id, description: "no" }, writeToken);
      expect(other.statusCode).toBe(403);

      // A station directly under the site evaluates site-level: plant roles only.
      const noWc = await rpcCall(server, "station/update", { id: stationNoWc.id, description: "no" }, writeToken);
      expect(noWc.statusCode).toBe(403);
    });

    it("WRITE grant updates its own workcenter config but not others", async () => {
      const own = await rpcCall(
        server,
        "workcenter/update",
        { id: wcGranted.id, description: `${PREFIX} mine` },
        writeToken,
      );
      expect(own.statusCode).toBe(200);
      const other = await rpcCall(server, "workcenter/update", { id: wcOther.id, description: "no" }, writeToken);
      expect(other.statusCode).toBe(403);
      // Creating a NEW workcenter is a site-level facility write.
      const create = await rpcCall(server, "workcenter/create", { siteId: siteA.id, name: `${PREFIX}-nope` }, writeToken);
      expect(create.statusCode).toBe(403);
    });

    it("plant-admin territory stays closed: settings, user management", async () => {
      const label = await rpcCall(server, "label/create", { siteId: siteA.id, name: `${PREFIX}-label` }, writeToken);
      expect(label.statusCode).toBe(403);
      const members = await rpcCall(server, "workspace/listMembers", {}, writeToken);
      expect(members.statusCode).toBe(403);
    });

    it("status taxonomy lists resolve through workcenter narrowing", async () => {
      const reasons = await rpcCall(server, "statusReason/list", { siteId: siteA.id }, readToken);
      expect(reasons.statusCode).toBe(200);
    });
  });

  describe("grant management", () => {
    it("plant admin manages grants in their own plant", async () => {
      const upsert = await rpcCall(
        server,
        "workcenterGrant/upsert",
        { userId: writeUserId, workcenterId: wcOther.id, access: "READ" },
        plantAdminToken,
      );
      expect(upsert.statusCode).toBe(200);

      const list = await rpcCall(server, "workcenterGrant/list", { userId: writeUserId }, plantAdminToken);
      expect(list.statusCode).toBe(200);
      const rows = (list.json as { data: Array<{ workcenterId: string }> }).data;
      expect(rows.map((r) => r.workcenterId)).toContain(wcOther.id);

      const remove = await rpcCall(
        server,
        "workcenterGrant/remove",
        { userId: writeUserId, workcenterId: wcOther.id },
        plantAdminToken,
      );
      expect(remove.statusCode).toBe(200);
    });

    it("plant admin cannot grant workcenters in another plant; company admin can", async () => {
      const denied = await rpcCall(
        server,
        "workcenterGrant/upsert",
        { userId: writeUserId, workcenterId: wcSiteB.id, access: "READ" },
        plantAdminToken,
      );
      expect(denied.statusCode).toBe(403);

      const allowed = await rpcCall(
        server,
        "workcenterGrant/upsert",
        { userId: writeUserId, workcenterId: wcSiteB.id, access: "READ" },
        companyAdminToken,
      );
      expect(allowed.statusCode).toBe(200);
      await rpcCall(server, "workcenterGrant/remove", { userId: writeUserId, workcenterId: wcSiteB.id }, companyAdminToken);
    });

    it("workcenter-only users cannot manage grants", async () => {
      const res = await rpcCall(
        server,
        "workcenterGrant/upsert",
        { userId: writeUserId, workcenterId: wcGranted.id, access: "READ" },
        writeToken,
      );
      expect(res.statusCode).toBe(403);
    });

    it("listMembers includes workcenter grants", async () => {
      const res = await rpcCall(server, "workspace/listMembers", {}, plantAdminToken);
      expect(res.statusCode).toBe(200);
      const members = (res.json as { data: Array<{ user: { email: string }; workcenterGrants: unknown[] }> }).data;
      const writer = members.find((m) => m.user.email === WRITE_EMAIL);
      expect(writer).toBeDefined();
      expect(writer?.workcenterGrants).toHaveLength(1);
    });
  });

  describe("member lifecycle", () => {
    it("invite with grants only creates a grant-holding membership", async () => {
      const plantAdmin = await prisma.user.findUniqueOrThrow({
        where: { email: PLANT_ADMIN_EMAIL },
        select: { id: true },
      });
      const result = await userService.createInvite({
        email: INVITEE_EMAIL,
        inviterId: plantAdmin.id,
        workspaceId,
        workcenterGrants: [{ workcenterId: wcGranted.id, access: "READ" }],
      });
      expect(result.success).toBe(true);

      const membership = await prisma.workspaceMembership.findFirstOrThrow({
        where: { user: { email: INVITEE_EMAIL }, workspaceId },
        select: { roleAssignments: true, workcenterGrants: true },
      });
      expect(membership.roleAssignments).toHaveLength(0);
      expect(membership.workcenterGrants).toHaveLength(1);
    });

    it("removeSiteAccess removes a grant-only membership entirely", async () => {
      const invitee = await prisma.user.findUniqueOrThrow({ where: { email: INVITEE_EMAIL }, select: { id: true } });
      const result = await workspaceService.removeSiteAccess(workspaceId, invitee.id, siteA.id);
      expect(result).toEqual({ success: true, membershipRemoved: true });
      const membership = await prisma.workspaceMembership.findFirst({
        where: { userId: invitee.id, workspaceId },
      });
      expect(membership).toBeNull();
    });
  });
});
