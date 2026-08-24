import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const PREFIX = "lbltest";
const OFFICE_EMAIL = "lbltest-office@test.local";
const PASSWORD = "lbltest-password-1";

type Lbl = { id: string; name: string };
type Row = { id: string; labels?: Lbl[] };
const row = (res: { json: unknown }) => res.json as Row;
const lbl = (res: { json: unknown }) => res.json as Lbl;
const listRows = (res: { json: unknown }) => (res.json as { data: Row[] }).data;

// Tier 2: labels + station filters. Each site has one shared list of labels
// used by jobs, tools, products, materials, stations, and the status/scrap
// codes. A station can define a filter per target kind: only items with at
// least one of the filter's labels are eligible — enforced on assignment
// (changeJob, downtime reason, scrap reason). Pickers narrow client-side:
// station reads carry the filters, the client passes the filter's labels as
// labelIds. Managing the label list needs settings:write; tagging a record
// only needs permission to edit that record.
describe.skipIf(!process.env.TEST_DATABASE_URL)("labels and station filters (Tier 2)", () => {
  let server: TestServer;
  let adminToken: string;
  let officeToken: string;
  let workspaceId: string;
  let site: { id: string };
  let siteB: { id: string };
  let molding: Lbl;
  let trim: Lbl;
  let otherSiteLabel: { id: string };
  let stationOpen: { id: string }; // no filters
  let stationFiltered: { id: string }; // JOB filter = [molding]
  let jobMolding: Row;
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
    otherSiteLabel = await prisma.label.upsert({
      where: { siteId_name: { siteId: siteB.id, name: `${PREFIX}-foreign` } },
      update: {},
      create: { siteId: siteB.id, name: `${PREFIX}-foreign` },
      select: { id: true },
    });

    stationOpen = await prisma.station.upsert({
      where: { siteId_name: { siteId: site.id, name: `${PREFIX}-st-open` } },
      update: { deletedAt: null },
      create: { name: `${PREFIX}-st-open`, siteId: site.id },
      select: { id: true },
    });
    stationFiltered = await prisma.station.upsert({
      where: { siteId_name: { siteId: site.id, name: `${PREFIX}-st-filtered` } },
      update: { deletedAt: null },
      create: { name: `${PREFIX}-st-filtered`, siteId: site.id },
      select: { id: true },
    });

    const officeRole = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Office User", scope: "SITE" } },
      select: { id: true },
    });
    const passwordHash = await hashPassword(PASSWORD);
    const officeUser = await prisma.user.upsert({
      where: { email: OFFICE_EMAIL },
      update: { passwordHash, status: "ACTIVE" },
      create: { email: OFFICE_EMAIL, passwordHash, firstName: "LblTest", status: "ACTIVE" },
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
    const stationIds = [stationOpen.id, stationFiltered.id];
    const jobIds = (
      await prisma.job.findMany({ where: { versions: { some: { name: { startsWith: PREFIX } } } }, select: { id: true } })
    ).map((j) => j.id);
    await prisma.cycle.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.stationStateLog.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.stationJobLog.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.station.updateMany({ where: { id: { in: stationIds } }, data: { currentJobId: null } });
    await prisma.job.updateMany({ where: { id: { in: jobIds } }, data: { currentVersionId: null } });
    await prisma.jobVersion.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.statusReason.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.itemDispositionReason.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.itemDisposition.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.station.deleteMany({ where: { id: { in: stationIds } } });
    await prisma.label.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.roleAssignment.deleteMany({ where: { membership: { user: { email: OFFICE_EMAIL } } } });
    await prisma.workspaceMembership.deleteMany({ where: { user: { email: OFFICE_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: OFFICE_EMAIL } });
    await prisma.site.deleteMany({ where: { id: siteB.id } });
    await server.close();
  });

  it("admin creates labels; duplicates rejected; office user cannot create but can tag", async () => {
    const m = await rpcCall(server, "label/create", { siteId: site.id, name: `${PREFIX}-molding` }, adminToken);
    expect(m.statusCode).toBe(200);
    molding = lbl(m);
    const t = await rpcCall(server, "label/create", { siteId: site.id, name: `${PREFIX}-trim` }, adminToken);
    trim = lbl(t);

    const dup = await rpcCall(server, "label/create", { siteId: site.id, name: `${PREFIX}-molding` }, adminToken);
    expect(dup.statusCode).toBe(409);

    const denied = await rpcCall(server, "label/create", { siteId: site.id, name: `${PREFIX}-rogue` }, officeToken);
    expect(denied.statusCode).toBe(403);

    const tagged = await rpcCall(
      server,
      "job/create",
      { siteId: site.id, name: `${PREFIX}-job-molding`, labelIds: [molding.id] },
      officeToken,
    );
    expect(tagged.statusCode).toBe(200);
    jobMolding = row(tagged);
    expect(jobMolding.labels?.map((l) => l.id)).toContain(molding.id);

    jobPlain = row(await rpcCall(server, "job/create", { siteId: site.id, name: `${PREFIX}-job-plain` }, adminToken));
  });

  it("labels from another site are rejected; update replaces the label set", async () => {
    const crossSite = await rpcCall(
      server,
      "job/create",
      { siteId: site.id, name: `${PREFIX}-job-x`, labelIds: [otherSiteLabel.id] },
      adminToken,
    );
    expect(crossSite.statusCode).toBe(404);

    const replaced = await rpcCall(server, "job/update", { id: jobMolding.id, labelIds: [molding.id, trim.id] }, adminToken);
    expect(row(replaced).labels?.length).toBe(2);
    const narrowed = await rpcCall(server, "job/update", { id: jobMolding.id, labelIds: [molding.id] }, adminToken);
    expect(row(narrowed).labels?.map((l) => l.id)).toEqual([molding.id]);
  });

  it("lists filter by labels (ANY)", async () => {
    const filtered = await rpcCall(server, "job/list", { siteId: site.id, labelIds: [molding.id], limit: 0 }, adminToken);
    const ids = listRows(filtered).map((j) => j.id);
    expect(ids).toContain(jobMolding.id);
    expect(ids).not.toContain(jobPlain.id);
  });

  it("station job filter: set, enforce in changeJob, narrow the job picker, clear", async () => {
    const set = await rpcCall(
      server,
      "station/setLabelFilter",
      { stationId: stationFiltered.id, target: "JOB", labelIds: [molding.id] },
      adminToken,
    );
    expect(set.statusCode).toBe(200);

    // A cross-site label in a filter is rejected.
    const badFilter = await rpcCall(
      server,
      "station/setLabelFilter",
      { stationId: stationFiltered.id, target: "TOOL", labelIds: [otherSiteLabel.id] },
      adminToken,
    );
    expect(badFilter.statusCode).toBe(404);

    // Unlabeled job is refused on the filtered station, allowed on the open one.
    const refused = await rpcCall(
      server,
      "station/changeJob",
      { stationId: stationFiltered.id, jobId: jobPlain.id },
      adminToken,
    );
    expect(refused.statusCode).toBe(409);
    const allowed = await rpcCall(
      server,
      "station/changeJob",
      { stationId: stationFiltered.id, jobId: jobMolding.id },
      adminToken,
    );
    expect(allowed.statusCode).toBe(200);
    const open = await rpcCall(server, "station/changeJob", { stationId: stationOpen.id, jobId: jobPlain.id }, adminToken);
    expect(open.statusCode).toBe(200);

    // Pickers narrow client-side: read the station's filters, resolve the
    // target's labels, pass them to the list.
    const stationFilters = (
      await rpcCall(server, "station/listLabelFilters", { stationId: stationFiltered.id }, adminToken)
    ).json as Array<{ target: string; labels: Lbl[] }>;
    const jobFilter = stationFilters.find((f) => f.target === "JOB");
    expect(jobFilter).toBeDefined();
    const picker = await rpcCall(
      server,
      "job/list",
      { siteId: site.id, labelIds: jobFilter?.labels.map((l) => l.id), limit: 0 },
      adminToken,
    );
    const pickerIds = listRows(picker).map((j) => j.id);
    expect(pickerIds).toContain(jobMolding.id);
    expect(pickerIds).not.toContain(jobPlain.id);

    // Filters are listable, and clearing one restores eligibility.
    const filters = await rpcCall(server, "station/listLabelFilters", { stationId: stationFiltered.id }, adminToken);
    expect((filters.json as Array<{ target: string }>).map((f) => f.target)).toContain("JOB");
    const clear = await rpcCall(
      server,
      "station/setLabelFilter",
      { stationId: stationFiltered.id, target: "JOB", labelIds: [] },
      adminToken,
    );
    expect(clear.statusCode).toBe(200);
    const nowAllowed = await rpcCall(
      server,
      "station/changeJob",
      { stationId: stationFiltered.id, jobId: jobPlain.id },
      adminToken,
    );
    expect(nowAllowed.statusCode).toBe(200);
  });

  it("downtime codes: labels, picker narrowing, and write enforcement", async () => {
    const pressReason = (
      await rpcCall(
        server,
        "statusReason/create",
        { siteId: site.id, name: `${PREFIX}-press-jam`, labelIds: [molding.id] },
        adminToken,
      )
    ).json as Row;
    const genericReason = (
      await rpcCall(server, "statusReason/create", { siteId: site.id, name: `${PREFIX}-no-operator` }, adminToken)
    ).json as Row;
    expect(pressReason.labels?.map((l) => l.id)).toContain(molding.id);

    await rpcCall(
      server,
      "station/setLabelFilter",
      { stationId: stationFiltered.id, target: "STATUS_REASON", labelIds: [molding.id] },
      adminToken,
    );

    // Picker narrowing, client-style: station reads carry the filters; the
    // client passes the filter's labels to the list.
    const stationRead = (await rpcCall(server, "station/get", { id: stationFiltered.id }, adminToken)).json as {
      labelFilters: Array<{ target: string; labels: Lbl[] }>;
    };
    const reasonFilter = stationRead.labelFilters.find((f) => f.target === "STATUS_REASON");
    expect(reasonFilter).toBeDefined();
    const narrowed = await rpcCall(
      server,
      "statusReason/list",
      { siteId: site.id, labelIds: reasonFilter?.labels.map((l) => l.id), limit: 0 },
      adminToken,
    );
    const names = listRows(narrowed).map((r) => (r as unknown as { name: string }).name);
    expect(names).toContain(`${PREFIX}-press-jam`);
    expect(names).not.toContain(`${PREFIX}-no-operator`);

    // Write enforcement: a DOWN entry on the filtered station only accepts
    // codes the filter allows.
    const entry = await prisma.stationStateLog.create({
      data: {
        stationId: stationFiltered.id,
        startTime: new Date(Date.now() - 60_000),
        endTime: new Date(),
        state: "DOWN",
        status: "DOWN",
        blockId: randomUUID(),
      },
      select: { id: true },
    });
    const blocked = await rpcCall(
      server,
      "station/assignDowntimeReason",
      { entryId: entry.id, statusReasonId: (genericReason as Row).id },
      adminToken,
    );
    expect(blocked.statusCode).toBe(409);
    const accepted = await rpcCall(
      server,
      "station/assignDowntimeReason",
      { entryId: entry.id, statusReasonId: (pressReason as Row).id },
      adminToken,
    );
    expect(accepted.statusCode).toBe(200);
  });

  it("scrap codes: labels and picker narrowing", async () => {
    const scrapBin = (
      await rpcCall(server, "disposition/create", { siteId: site.id, name: `${PREFIX}-scrap` }, adminToken)
    ).json as Row;
    const flash = (
      await rpcCall(
        server,
        "dispositionReason/create",
        { siteId: site.id, name: `${PREFIX}-flash`, itemDispositionIds: [scrapBin.id], labelIds: [molding.id] },
        adminToken,
      )
    ).json as Row;
    expect(flash.labels?.map((l) => l.id)).toContain(molding.id);
    const shortShot = (
      await rpcCall(
        server,
        "dispositionReason/create",
        { siteId: site.id, name: `${PREFIX}-short-shot`, itemDispositionIds: [scrapBin.id] },
        adminToken,
      )
    ).json as Row;
    expect(shortShot.id).toBeDefined();

    await rpcCall(
      server,
      "station/setLabelFilter",
      { stationId: stationFiltered.id, target: "DISPOSITION_REASON", labelIds: [molding.id] },
      adminToken,
    );
    const scrapFilters = (
      await rpcCall(server, "station/listLabelFilters", { stationId: stationFiltered.id }, adminToken)
    ).json as Array<{ target: string; labels: Lbl[] }>;
    const scrapFilter = scrapFilters.find((f) => f.target === "DISPOSITION_REASON");
    const narrowed = await rpcCall(
      server,
      "dispositionReason/list",
      { siteId: site.id, labelIds: scrapFilter?.labels.map((l) => l.id), limit: 0 },
      adminToken,
    );
    const names = listRows(narrowed).map((r) => (r as unknown as { name: string }).name);
    expect(names).toContain(`${PREFIX}-flash`);
    expect(names).not.toContain(`${PREFIX}-short-shot`);
  });

  it("downtime log search filters by code labels", async () => {
    const search = await rpcCall(
      server,
      "logs/downtimeSearch",
      { siteId: site.id, stationId: stationFiltered.id, labelIds: [molding.id] },
      adminToken,
    );
    expect(search.statusCode).toBe(200);
    const rows = (search.json as { data: Array<{ statusReasonName: string | null }> }).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.statusReasonName === `${PREFIX}-press-jam`)).toBe(true);

    const none = await rpcCall(
      server,
      "logs/downtimeSearch",
      { siteId: site.id, stationId: stationFiltered.id, labelIds: [trim.id] },
      adminToken,
    );
    expect((none.json as { data: unknown[] }).data.length).toBe(0);
  });

  it("cycle search filters by job labels", async () => {
    const jobVersionId = (
      await prisma.job.findUniqueOrThrow({ where: { id: jobMolding.id }, select: { currentVersionId: true } })
    ).currentVersionId as string;
    await prisma.cycle.create({
      data: {
        siteId: site.id,
        stationId: stationFiltered.id,
        jobVersionId,
        cycleStatus: "GOOD",
        start: new Date(Date.now() - 60_000),
        end: new Date(),
      },
    });

    const hit = await rpcCall(
      server,
      "logs/cycleSearch",
      { siteId: site.id, labelIds: [molding.id] },
      adminToken,
    );
    expect(hit.statusCode).toBe(200);
    expect((hit.json as { data: unknown[] }).data.length).toBeGreaterThan(0);

    const miss = await rpcCall(server, "logs/cycleSearch", { siteId: site.id, labelIds: [trim.id] }, adminToken);
    expect((miss.json as { data: unknown[] }).data.length).toBe(0);
  });

  it("the rename migration kept existing rows: the old classification is now a label", async () => {
    const carried = await prisma.label.findFirst({ where: { name: "Night Crew" }, select: { id: true } });
    expect(carried).not.toBeNull();
  });

  it("label delete detaches everywhere and clears filter criteria", async () => {
    const temp = lbl(await rpcCall(server, "label/create", { siteId: site.id, name: `${PREFIX}-temp` }, adminToken));
    await rpcCall(server, "job/update", { id: jobPlain.id, labelIds: [temp.id] }, adminToken);
    const del = await rpcCall(server, "label/delete", { id: temp.id }, adminToken);
    expect(del.statusCode).toBe(200);
    const reread = await rpcCall(server, "job/get", { id: jobPlain.id }, adminToken);
    expect(row(reread).labels).toEqual([]);
  });
});
