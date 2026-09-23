import prisma from "@rw/db";
import { workcenter } from "@rw/services/facility/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlantBucket, ensureWorkcenterBucket, makeUser, setWorkcenterAccess } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const FA_EMAIL = "authz-fa@test.local";
const READER_EMAIL = "authz-reader@test.local";
const MEMBER_EMAIL = "authz-member@test.local";
const NOROLE_EMAIL = "authz-norole@test.local";
const ADMIN_EMAIL = "authz-admin@test.local";
const PASSWORD = "authz-password-123";
const EMAILS = [FA_EMAIL, READER_EMAIL, MEMBER_EMAIL, NOROLE_EMAIL, ADMIN_EMAIL];

const NONEXISTENT_ID = "00000000-0000-4000-8000-000000000000";

// Tier 2: site-scope and level enforcement through the policy layer, on both
// the RPC and REST surfaces, under the bucket model.
// Fixtures live in the single default workspace: the seeded "Rockware" site
// (site A) plus a second site B. Bucket-era cast:
//   fa      plant ADMIN at site A (was the "Plant Admin" role)
//   reader  crew VIEW at workcenter A — floor visibility is crew
//           membership now (was a custom production:read role)
//   member  plant VIEW at site A — a plain plant member
//   admin   workspace OWNER (was "Company Administrator")
//   norole  membership with no bucket accesses at all
describe.skipIf(!process.env.TEST_DATABASE_URL)("facility authorization (Tier 2)", () => {
  let server: TestServer;
  let siteA: { id: string };
  let siteB: { id: string };
  let wcA: { id: string };
  let wcB: { id: string };
  let stationA: { id: string };
  let stationB: { id: string };
  let downEntryB: { id: string };
  let memberUserId: string;
  let faToken: string;
  let readerToken: string;
  let memberToken: string;
  let noroleToken: string;
  let adminToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    // Anchor on the seeded "Rockware" site rather than a workspace slug —
    // Tier 2 databases are copies of a provisioned deployment and the slug
    // varies ("default" from seed.ts, "rw" on longer-lived databases).
    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    const workspace = { id: rockware.workspaceId };
    siteA = { id: rockware.id };
    siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId: workspace.id, name: "AuthZ Site B" } },
      update: {},
      create: { name: "AuthZ Site B", workspaceId: workspace.id },
      select: { id: true },
    });
    await ensurePlantBucket(workspace.id, siteB.id, "AuthZ Site B");

    const findOrCreateWorkcenter = async (siteId: string, name: string) => {
      const existing = await prisma.workcenter.findFirst({ where: { siteId, name }, select: { id: true } });
      return existing ?? prisma.workcenter.create({ data: { name, siteId }, select: { id: true } });
    };
    wcA = await findOrCreateWorkcenter(siteA.id, "authz-wc-a");
    wcB = await findOrCreateWorkcenter(siteB.id, "authz-wc-b");
    // Raw-prisma workcenters bypass the service hook — heal their buckets.
    await ensureWorkcenterBucket(workspace.id, siteA.id, wcA.id, "authz-wc-a");
    await ensureWorkcenterBucket(workspace.id, siteB.id, wcB.id, "authz-wc-b");
    stationA = await prisma.station.upsert({
      where: { siteId_name: { siteId: siteA.id, name: "authz-st-a" } },
      update: {},
      create: { name: "authz-st-a", siteId: siteA.id, workcenterId: wcA.id },
      select: { id: true },
    });
    stationB = await prisma.station.upsert({
      where: { siteId_name: { siteId: siteB.id, name: "authz-st-b" } },
      update: {},
      create: { name: "authz-st-b", siteId: siteB.id, workcenterId: wcB.id },
      select: { id: true },
    });
    downEntryB = await prisma.stationStateLog.create({
      data: {
        stationId: stationB.id,
        state: "DOWN",
        startTime: new Date("2026-01-01T00:00:00Z"),
        endTime: new Date("2026-01-01T00:10:00Z"),
        blockId: "authz-block-b",
      },
      select: { id: true },
    });

    await makeUser(FA_EMAIL, PASSWORD, { plants: [{ siteId: siteA.id, level: "ADMIN" }] });
    await makeUser(READER_EMAIL, PASSWORD, { workcenters: [{ workcenterId: wcA.id, level: "VIEW" }] });
    const member = await makeUser(MEMBER_EMAIL, PASSWORD, {
      plants: [{ siteId: siteA.id, level: "VIEW" }],
    });
    memberUserId = member.userId;
    await makeUser(ADMIN_EMAIL, PASSWORD, { accountAdmin: true });
    await makeUser(NOROLE_EMAIL, PASSWORD);

    // One login per user for the whole suite — the sensitive-endpoint rate
    // limiter allows 5/min/IP and every inject comes from 127.0.0.1. Five
    // users is exactly the budget; add a sixth and this beforeAll gets 429s.
    faToken = (await loginAs(server, FA_EMAIL, PASSWORD)).accessToken;
    readerToken = (await loginAs(server, READER_EMAIL, PASSWORD)).accessToken;
    memberToken = (await loginAs(server, MEMBER_EMAIL, PASSWORD)).accessToken;
    noroleToken = (await loginAs(server, NOROLE_EMAIL, PASSWORD)).accessToken;
    adminToken = (await loginAs(server, ADMIN_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
    await prisma.stationStateLog.deleteMany({ where: { blockId: "authz-block-b" } });
    await prisma.station.deleteMany({ where: { name: { in: ["authz-st-a", "authz-st-b"] } } });
    await prisma.workcenter.deleteMany({ where: { name: { in: ["authz-wc-a", "authz-wc-b"] } } });
    await prisma.site.deleteMany({ where: { name: "AuthZ Site B" } });
    await server.close();
  });

  describe("scoped list queries", () => {
    // Name filters keep the assertions stable on Tier 2 databases that carry
    // pre-existing rows (list defaults cap at 50).
    it("site.list returns only the granted site for a site-scoped user", async () => {
      const allowed = await rpcCall(server, "site/list", { name: "Rockware" }, faToken);
      expect(allowed.statusCode).toBe(200);
      expect((allowed.json as { data: Array<{ id: string }> }).data.map((s) => s.id)).toContain(siteA.id);

      const filtered = await rpcCall(server, "site/list", { name: "AuthZ" }, faToken);
      expect(filtered.statusCode).toBe(200);
      expect((filtered.json as { data: Array<{ id: string }> }).data).toEqual([]);
    });

    it("site.list includes the other site for the workspace owner", async () => {
      const res = await rpcCall(server, "site/list", { name: "AuthZ" }, adminToken);
      expect(res.statusCode).toBe(200);
      const ids = (res.json as { data: Array<{ id: string }> }).data.map((s) => s.id);
      expect(ids).toContain(siteB.id);
    });

    it("station.list excludes stations outside the granted site", async () => {
      const res = await rpcCall(server, "station/list", { name: "authz-st" }, faToken);
      expect(res.statusCode).toBe(200);
      const ids = (res.json as { data: Array<{ id: string }> }).data.map((s) => s.id);
      expect(ids).toContain(stationA.id);
      expect(ids).not.toContain(stationB.id);
    });

    it("workcenter.list excludes workcenters outside the granted site", async () => {
      const res = await rpcCall(server, "workcenter/list", { name: "authz-wc" }, faToken);
      expect(res.statusCode).toBe(200);
      const ids = (res.json as { data: Array<{ id: string }> }).data.map((w) => w.id);
      expect(ids).not.toContain(wcB.id);
    });

    it("requesting a non-granted siteId on list is denied", async () => {
      const stations = await rpcCall(server, "station/list", { siteId: siteB.id }, faToken);
      expect(stations.statusCode).toBe(403);
      const workcenters = await rpcCall(server, "workcenter/list", { siteId: siteB.id }, faToken);
      expect(workcenters.statusCode).toBe(403);
    });

    it("a member with no bucket accesses sees an empty site directory and no site context", async () => {
      // The site directory (picker) stays reachable and empty…
      const res = await rpcCall(server, "site/list", {}, noroleToken);
      expect(res.statusCode).toBe(200);
      expect((res.json as { data: unknown[] }).data).toEqual([]);
      // …but domain lists are single-site, and this token has no site.
      const stations = await rpcCall(server, "station/list", {}, noroleToken);
      expect(stations.statusCode).toBe(400);
    });
  });

  describe("identifier swaps and single-record scope", () => {
    it("site.get on the granted site succeeds; on the other site is denied", async () => {
      const allowed = await rpcCall(server, "site/get", { id: siteA.id }, faToken);
      expect(allowed.statusCode).toBe(200);
      const denied = await rpcCall(server, "site/get", { id: siteB.id }, faToken);
      expect(denied.statusCode).toBe(403);
    });

    it("station.get / workcenter.get across the site boundary are denied", async () => {
      const st = await rpcCall(server, "station/get", { id: stationB.id }, faToken);
      expect(st.statusCode).toBe(403);
      const wc = await rpcCall(server, "workcenter/get", { id: wcB.id }, faToken);
      expect(wc.statusCode).toBe(403);
    });

    it("a nonexistent resource id is NOT_FOUND, resolved before any permission check", async () => {
      const res = await rpcCall(server, "station/get", { id: NONEXISTENT_ID }, faToken);
      expect(res.statusCode).toBe(404);
    });

    it("requests without a token are unauthorized", async () => {
      const res = await rpcCall(server, "site/list", {});
      expect(res.statusCode).toBe(401);
    });
  });

  describe("levels within the granted site", () => {
    it("a crew VIEW member can watch the floor but not write stations", async () => {
      const read = await rpcCall(server, "station/get", { id: stationA.id }, readerToken);
      expect(read.statusCode).toBe(200);
      const write = await rpcCall(server, "station/update", { id: stationA.id, description: "nope" }, readerToken);
      expect(write.statusCode).toBe(403);
      const remove = await rpcCall(server, "station/delete", { id: stationA.id }, readerToken);
      expect(remove.statusCode).toBe(403);
    });

    it("crew access grants automatic plant membership (common plant reads)", async () => {
      // Any workcenter access makes the user a member of the site's plant
      // bucket, so plant-level reads like site.get and workcenter.list work.
      const site = await rpcCall(server, "site/get", { id: siteA.id }, readerToken);
      expect(site.statusCode).toBe(200);
      const wcs = await rpcCall(server, "workcenter/list", { name: "authz-wc" }, readerToken);
      expect(wcs.statusCode).toBe(200);
    });

    it("plant VIEW members canNOT read the floor: stations are crew territory", async () => {
      // FLIP from the key model: plant membership no longer implies floor
      // visibility — station reads require crew membership (or plant ADMIN
      // via the cascade).
      const get = await rpcCall(server, "station/get", { id: stationA.id }, memberToken);
      expect(get.statusCode).toBe(403);
      const list = await rpcCall(server, "station/list", { name: "authz-st" }, memberToken);
      expect(list.statusCode).toBe(403);
      // The common plant things stay member-readable.
      const wcs = await rpcCall(server, "workcenter/list", { name: "authz-wc" }, memberToken);
      expect(wcs.statusCode).toBe(200);
    });

    it("station update needs plant ADMIN: crew MANAGE runs the cell but cannot set it up", async () => {
      // Setting up stations is shop-floor setup (plant ADMIN). The bucket
      // snapshot is resolved per request, so upgrading the member's crew
      // access takes effect without a new login.
      await setWorkcenterAccess(memberUserId, wcA.id, "MANAGE");
      try {
        const res = await rpcCall(
          server,
          "station/update",
          { id: stationA.id, description: "authz crew manage" },
          memberToken,
        );
        expect(res.statusCode).toBe(403);
      } finally {
        await prisma.bucketAccess.deleteMany({
          where: { userId: memberUserId, bucket: { workcenterId: wcA.id } },
        });
      }
    });

    it("plant ADMIN can write stations in their site (MANAGE cascades to every cell)", async () => {
      const res = await rpcCall(server, "station/update", { id: stationA.id, description: "authz test" }, faToken);
      expect(res.statusCode).toBe(200);
    });

    it("plant-scoped levels cannot create sites (owner-level action)", async () => {
      const res = await rpcCall(server, "site/create", { name: "authz-should-not-exist" }, faToken);
      expect(res.statusCode).toBe(403);
    });
  });

  describe("workcenter nesting is blocked", () => {
    it("create ignores parentId (schema) and the service rejects it outright", async () => {
      // RPC input schema no longer carries parentId — a stray field is
      // stripped, so the created workcenter is top-level.
      const created = await rpcCall(
        server,
        "workcenter/create",
        { siteId: siteA.id, name: "authz-wc-flat", parentId: wcB.id },
        faToken,
      );
      expect(created.statusCode).toBe(200);
      const row = created.json as { id: string; parentId: string | null };
      expect(row.parentId).toBeNull();

      // Service-level guard for callers that bypass the RPC schema.
      const rejected = await workcenter.create({ siteId: siteA.id, name: "authz-wc-nested", parentId: row.id });
      expect("error" in rejected && rejected.code).toBe("WORKCENTER_NESTING_UNSUPPORTED");

      await prisma.workcenter.delete({ where: { id: row.id } });
    });

    it("move accepts only parentId null; a target parent is rejected", async () => {
      const parent = await prisma.workcenter.findFirstOrThrow({
        where: { siteId: siteA.id, name: "authz-wc-a" },
        select: { id: true },
      });

      const nested = await rpcCall(server, "workcenter/move", { id: parent.id, parentId: wcB.id }, faToken);
      expect(nested.statusCode).toBe(400);
      const child = await prisma.workcenter.create({
        data: { siteId: siteA.id, name: "authz-wc-legacy-child", parentId: parent.id },
        select: { id: true },
      });
      // Raw-prisma workcenter: heal its bucket so the plant-ADMIN cascade
      // has a container to land on (no bucket = no access, even cascaded).
      const workspace = await prisma.site.findUniqueOrThrow({
        where: { id: siteA.id },
        select: { workspaceId: true },
      });
      await ensureWorkcenterBucket(workspace.workspaceId, siteA.id, child.id, "authz-wc-legacy-child");
      const flattened = await rpcCall(server, "workcenter/move", { id: child.id, parentId: null }, faToken);
      expect(flattened.statusCode).toBe(200);
      const after = await prisma.workcenter.findUniqueOrThrow({ where: { id: child.id }, select: { parentId: true } });
      expect(after.parentId).toBeNull();

      await prisma.workcenter.delete({ where: { id: child.id } });
    });
  });

  describe("previously unchecked station procedures", () => {
    it("station event and datasource reads outside the granted site are denied", async () => {
      const events = await rpcCall(server, "station/listEvents", { stationId: stationB.id }, faToken);
      expect(events.statusCode).toBe(403);
      const datasources = await rpcCall(server, "station/listDatasources", { stationId: stationB.id }, faToken);
      expect(datasources.statusCode).toBe(403);
      const stateLogs = await rpcCall(server, "station/listStateLogs", { stationId: stationB.id }, faToken);
      expect(stateLogs.statusCode).toBe(403);
    });

    it("changeJob requires MANAGE at the station's cell", async () => {
      const res = await rpcCall(server, "station/changeJob", { stationId: stationA.id, jobId: null }, readerToken);
      expect(res.statusCode).toBe(403);
    });

    it("assignDowntimeReason resolves the entry's cell and requires MANAGE there", async () => {
      // Entry belongs to site B; the plant ADMIN grant covers site A only.
      const outOfScope = await rpcCall(
        server,
        "station/assignDowntimeReason",
        { entryId: downEntryB.id, statusReasonId: null },
        faToken,
      );
      expect(outOfScope.statusCode).toBe(403);

      const missing = await rpcCall(
        server,
        "station/assignDowntimeReason",
        { entryId: NONEXISTENT_ID, statusReasonId: null },
        faToken,
      );
      expect(missing.statusCode).toBe(404);
    });
  });

  describe("REST surface", () => {
    const restGet = (url: string, token: string) =>
      server.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

    it("GET /sites filters to the granted site", async () => {
      const res = await restGet("/sites?name=AuthZ", faToken);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { data: unknown[] }).data).toEqual([]);
    });

    it("GET /sites/:id and /stations/:id across the boundary are denied", async () => {
      const site = await restGet(`/sites/${siteB.id}`, faToken);
      expect(site.statusCode).toBe(403);
      const station = await restGet(`/stations/${stationB.id}`, faToken);
      expect(station.statusCode).toBe(403);
    });

    it("GET /workcenters?siteId= outside the grant is denied", async () => {
      const res = await restGet(`/workcenters?siteId=${siteB.id}`, faToken);
      expect(res.statusCode).toBe(403);
    });

    it("GET /stations/:id for a nonexistent id is 404", async () => {
      const res = await restGet(`/stations/${NONEXISTENT_ID}`, faToken);
      expect(res.statusCode).toBe(404);
    });
  });
});
