import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const PREFIX = "clstest";
const OFFICE_EMAIL = "clstest-office@test.local";
const PASSWORD = "clstest-password-1";

type Cls = { id: string; name: string; kind: "GROUP" | "CAPABILITY" };
type Row = { id: string; classifications?: Cls[] };
const row = (res: { json: unknown }) => res.json as Row;
const cls = (res: { json: unknown }) => res.json as Cls;
const listRows = (res: { json: unknown }) => (res.json as { data: Row[] }).data;

// Tier 2: classifications — each site has one shared list of labels used by
// jobs, tools, products, materials, and stations. GROUP labels just group
// things; CAPABILITY labels are rules — a job only runs on a station that
// has every CAPABILITY label the job carries (checked in changeJob).
// Managing the label list needs settings:write; putting labels on a record
// only needs permission to edit that record.
describe.skipIf(!process.env.TEST_DATABASE_URL)("classifications (Tier 2)", () => {
  let server: TestServer;
  let adminToken: string;
  let officeToken: string;
  let workspaceId: string;
  let site: { id: string };
  let siteB: { id: string };
  let molding: Cls; // GROUP
  let press1t: Cls; // CAPABILITY
  let otherSiteCls: { id: string }; // in siteB
  let stationPlain: { id: string }; // no classifications
  let stationPress: { id: string }; // has press1t
  let jobPlain: Row;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    site = { id: rockware.id };
    workspaceId = rockware.workspaceId;
    siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId, name: `${PREFIX} Site B` } },
      update: {},
      create: { name: `${PREFIX} Site B`, workspaceId },
      select: { id: true },
    });
    otherSiteCls = await prisma.classification.upsert({
      where: { siteId_name: { siteId: siteB.id, name: `${PREFIX}-foreign` } },
      update: {},
      create: { siteId: siteB.id, name: `${PREFIX}-foreign` },
      select: { id: true },
    });

    stationPlain = await prisma.station.upsert({
      where: { siteId_name: { siteId: site.id, name: `${PREFIX}-st-plain` } },
      update: { deletedAt: null },
      create: { name: `${PREFIX}-st-plain`, siteId: site.id },
      select: { id: true },
    });
    stationPress = await prisma.station.upsert({
      where: { siteId_name: { siteId: site.id, name: `${PREFIX}-st-press` } },
      update: { deletedAt: null },
      create: { name: `${PREFIX}-st-press`, siteId: site.id },
      select: { id: true },
    });

    // Office User: job:write etc., no settings:write.
    const officeRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Office User", scope: "SITE" } },
      select: { id: true },
    });
    const passwordHash = await hashPassword(PASSWORD);
    const officeUser = await prisma.user.upsert({
      where: { email: OFFICE_EMAIL },
      update: { passwordHash, status: "ACTIVE" },
      create: { email: OFFICE_EMAIL, passwordHash, firstName: "ClsTest", status: "ACTIVE" },
    });
    const membership = await prisma.workspaceMembership.upsert({
      where: { userId_workspaceId: { userId: officeUser.id, workspaceId } },
      update: {},
      create: { userId: officeUser.id, workspaceId },
    });
    const existingAssignment = await prisma.roleAssignment.findFirst({
      where: { membershipId: membership.id, roleId: officeRole.id, siteId: site.id },
    });
    if (!existingAssignment) {
      await prisma.roleAssignment.create({
        data: { membershipId: membership.id, roleId: officeRole.id, siteId: site.id },
      });
    }

    adminToken = (
      await loginAs(
        server,
        process.env.TEST_ADMIN_EMAIL ?? "admin@test.local",
        process.env.TEST_ADMIN_PASSWORD ?? "test-password-123",
      )
    ).accessToken;
    officeToken = (await loginAs(server, OFFICE_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    const jobIds = (
      await prisma.job.findMany({ where: { versions: { some: { name: { startsWith: PREFIX } } } }, select: { id: true } })
    ).map((j) => j.id);
    await prisma.stationJobLog.deleteMany({ where: { stationId: { in: [stationPlain.id, stationPress.id] } } });
    await prisma.stationStateLog.deleteMany({ where: { stationId: { in: [stationPlain.id, stationPress.id] } } });
    await prisma.station.updateMany({
      where: { id: { in: [stationPlain.id, stationPress.id] } },
      data: { currentJobId: null },
    });
    await prisma.job.updateMany({ where: { id: { in: jobIds } }, data: { currentVersionId: null } });
    await prisma.jobVersion.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.station.deleteMany({ where: { id: { in: [stationPlain.id, stationPress.id] } } });
    await prisma.classification.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.roleAssignment.deleteMany({ where: { membership: { user: { email: OFFICE_EMAIL } } } });
    await prisma.workspaceMembership.deleteMany({ where: { user: { email: OFFICE_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: OFFICE_EMAIL } });
    await prisma.site.deleteMany({ where: { id: siteB.id } });
    await server.close();
  });

  it("admin creates GROUP and CAPABILITY classifications; duplicates are rejected", async () => {
    const g = await rpcCall(server, "classification/create", { siteId: site.id, name: `${PREFIX}-molding` }, adminToken);
    expect(g.statusCode).toBe(200);
    molding = cls(g);
    expect(molding.kind).toBe("GROUP");

    const c = await rpcCall(
      server,
      "classification/create",
      { siteId: site.id, name: `${PREFIX}-1t-press`, kind: "CAPABILITY" },
      adminToken,
    );
    expect(c.statusCode).toBe(200);
    press1t = cls(c);
    expect(press1t.kind).toBe("CAPABILITY");

    const dup = await rpcCall(server, "classification/create", { siteId: site.id, name: `${PREFIX}-molding` }, adminToken);
    expect(dup.statusCode).toBe(409);
  });

  it("vocabulary is curated: office user cannot create, but can assign existing ones", async () => {
    const denied = await rpcCall(
      server,
      "classification/create",
      { siteId: site.id, name: `${PREFIX}-rogue` },
      officeToken,
    );
    expect(denied.statusCode).toBe(403);

    const created = await rpcCall(
      server,
      "job/create",
      { siteId: site.id, name: `${PREFIX}-job-tagged`, classificationIds: [molding.id] },
      officeToken,
    );
    expect(created.statusCode).toBe(200);
    expect(row(created).classifications?.map((c) => c.id)).toContain(molding.id);
  });

  it("assignment validates site membership and update replaces the set", async () => {
    const crossSite = await rpcCall(
      server,
      "job/create",
      { siteId: site.id, name: `${PREFIX}-job-x`, classificationIds: [otherSiteCls.id] },
      adminToken,
    );
    expect(crossSite.statusCode).toBe(404);

    const created = await rpcCall(server, "job/create", { siteId: site.id, name: `${PREFIX}-job-set` }, adminToken);
    jobPlain = row(created);
    expect(jobPlain.classifications).toEqual([]);

    const tagged = await rpcCall(
      server,
      "job/update",
      { id: jobPlain.id, classificationIds: [molding.id, press1t.id] },
      adminToken,
    );
    expect(tagged.statusCode).toBe(200);
    expect(row(tagged).classifications?.length).toBe(2);

    const replaced = await rpcCall(server, "job/update", { id: jobPlain.id, classificationIds: [molding.id] }, adminToken);
    expect(row(replaced).classifications?.map((c) => c.id)).toEqual([molding.id]);
  });

  it("lists filter by classification with ANY semantics", async () => {
    const filtered = await rpcCall(
      server,
      "job/list",
      { siteId: site.id, classificationIds: [molding.id], limit: 0 },
      adminToken,
    );
    const ids = listRows(filtered).map((j) => j.id);
    expect(ids).toContain(jobPlain.id);

    const none = await rpcCall(
      server,
      "job/list",
      { siteId: site.id, classificationIds: [press1t.id], limit: 0 },
      adminToken,
    );
    expect(listRows(none).map((j) => j.id)).not.toContain(jobPlain.id);

    // Station side: tag stationPress with the capability, then filter.
    const st = await rpcCall(
      server,
      "station/update",
      { id: stationPress.id, classificationIds: [press1t.id] },
      adminToken,
    );
    expect(st.statusCode).toBe(200);
    const stations = await rpcCall(
      server,
      "station/list",
      { siteId: site.id, classificationIds: [press1t.id], limit: 0 },
      adminToken,
    );
    const stIds = listRows(stations).map((s) => s.id);
    expect(stIds).toContain(stationPress.id);
    expect(stIds).not.toContain(stationPlain.id);
  });

  it("changeJob enforces capability subset; GROUP labels never block", async () => {
    const capJobRes = await rpcCall(
      server,
      "job/create",
      { siteId: site.id, name: `${PREFIX}-job-cap`, classificationIds: [press1t.id, molding.id] },
      adminToken,
    );
    const capJob = row(capJobRes);

    // Station without the capability → refused, message names it.
    const refused = await rpcCall(
      server,
      "station/changeJob",
      { stationId: stationPlain.id, jobId: capJob.id },
      adminToken,
    );
    expect(refused.statusCode).toBe(409);
    expect((refused.json as { message?: string } | undefined) ?? {}).toBeDefined();

    // Station with the capability → allowed (the GROUP label is irrelevant).
    const allowed = await rpcCall(
      server,
      "station/changeJob",
      { stationId: stationPress.id, jobId: capJob.id },
      adminToken,
    );
    expect(allowed.statusCode).toBe(200);

    // A job with only GROUP labels runs anywhere.
    const groupOnly = await rpcCall(
      server,
      "station/changeJob",
      { stationId: stationPlain.id, jobId: jobPlain.id },
      adminToken,
    );
    expect(groupOnly.statusCode).toBe(200);
  });

  it("deleting a classification detaches it everywhere and unblocks matching", async () => {
    const capJob = (
      await rpcCall(
        server,
        "job/create",
        { siteId: site.id, name: `${PREFIX}-job-cap2`, classificationIds: [press1t.id] },
        adminToken,
      )
    ).json as Row;

    const del = await rpcCall(server, "classification/delete", { id: press1t.id }, adminToken);
    expect(del.statusCode).toBe(200);

    const reread = await rpcCall(server, "job/get", { id: capJob.id }, adminToken);
    expect(row(reread).classifications).toEqual([]);

    // Requirement gone → previously incompatible station now accepts the job.
    const nowAllowed = await rpcCall(
      server,
      "station/changeJob",
      { stationId: stationPlain.id, jobId: capJob.id },
      adminToken,
    );
    expect(nowAllowed.statusCode).toBe(200);
  });

  it("rename via update and list scoping to the active site", async () => {
    const renamed = await rpcCall(
      server,
      "classification/update",
      { id: molding.id, name: `${PREFIX}-molding-renamed` },
      adminToken,
    );
    expect(renamed.statusCode).toBe(200);
    expect(cls(renamed).name).toBe(`${PREFIX}-molding-renamed`);

    const list = await rpcCall(server, "classification/list", { siteId: site.id, limit: 0 }, adminToken);
    expect(list.statusCode).toBe(200);
    const names = listRows(list).map((c) => (c as unknown as Cls).name);
    expect(names).toContain(`${PREFIX}-molding-renamed`);
    expect(names).not.toContain(`${PREFIX}-foreign`);
  });
});
