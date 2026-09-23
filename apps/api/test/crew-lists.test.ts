import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlantBucket, ensureWorkcenterBucket, makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const EMAIL = "crew-lists@test.local";
const PASSWORD = "crew-lists-password-1";

// Tier 2: a crew member of one cell lists stations on both surfaces and sees
// their cell plus cell-less stations, never the other cell. (REST
// GET /stations used to return the whole site.)
describe.skipIf(!process.env.TEST_DATABASE_URL)("crew floor lists (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let token: string;
  const stations: Record<"none" | "mine" | "other", string> = { none: "", mine: "", other: "" };

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    const anchor = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { workspaceId: true } });
    const workspaceId = anchor.workspaceId;
    const site = await prisma.site.create({ data: { workspaceId, name: "Crew Lists Site" }, select: { id: true } });
    siteId = site.id;
    await ensurePlantBucket(workspaceId, siteId, "Crew Lists Site");
    const mine = await prisma.workcenter.create({ data: { siteId, name: "cl-mine" }, select: { id: true } });
    const other = await prisma.workcenter.create({ data: { siteId, name: "cl-other" }, select: { id: true } });
    await ensureWorkcenterBucket(workspaceId, siteId, mine.id, "cl-mine");
    await ensureWorkcenterBucket(workspaceId, siteId, other.id, "cl-other");
    const make = (name: string, workcenterId: string | null) =>
      prisma.station.create({ data: { siteId, name, workcenterId }, select: { id: true } }).then((s) => s.id);
    stations.none = await make("cl-none", null);
    stations.mine = await make("cl-mine", mine.id);
    stations.other = await make("cl-other", other.id);

    await makeUser(workspaceId, EMAIL, PASSWORD, { workcenters: [{ workcenterId: mine.id, level: "VIEW" }] });
    token = (await loginAs(server, EMAIL, PASSWORD)).accessToken;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await prisma.site.deleteMany({ where: { id: siteId } });
    await server.close();
  });

  const expectCrewView = (ids: string[]) => {
    expect(ids).toContain(stations.mine);
    expect(ids).toContain(stations.none);
    expect(ids).not.toContain(stations.other);
  };

  it("RPC station.list", async () => {
    const res = await rpcCall(server, "station/list", { siteId }, token);
    expect(res.statusCode).toBe(200);
    expectCrewView((res.json as { data: Array<{ id: string }> }).data.map((s) => s.id));
  });

  it("REST GET /stations", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/stations?siteId=${siteId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expectCrewView((res.json() as { data: Array<{ id: string }> }).data.map((s) => s.id));
  });
});
