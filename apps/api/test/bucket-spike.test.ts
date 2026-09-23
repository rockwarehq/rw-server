import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

// ─── SPIKE v3: Basecamp-bucket access model ─────────────────────────────
// Two containers only. A PLANT bucket everyone at the site is in
// (VIEW=member / MANAGE=write everything / ADMIN=the reserved shelf) and a
// WORKCENTER bucket per cell for the crew (VIEW/WORK). Owners bypass.
// Runs ONLY against the dedicated spike database.

const PASSWORD = "bucket-spike-password-1";
const EMAILS = {
  crew: "bucket-crew@test.local",
  member: "bucket-member@test.local",
  manager: "bucket-manager@test.local",
  padmin: "bucket-padmin@test.local",
  plain: "bucket-plain@test.local",
  owner: "bucket-owner@test.local",
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("bucket spike v3 (Tier 2)", () => {
  let server: TestServer;
  let workspaceId: string;
  let siteB: { id: string };
  let wc1: { id: string };
  let wc2: { id: string };
  let s1: { id: string };
  let s2: { id: string };
  let sNull: { id: string };
  let gatewayB: { id: string };
  let gatewayPool: { id: string };
  let wc1Bucket: { id: string };
  const tokens: Record<keyof typeof EMAILS, string> = {} as never;

  let ipCounter = 10;
  const loginFrom = async (email: string) => {
    const res = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: PASSWORD },
      remoteAddress: `127.0.0.${ipCounter++}`,
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });
    workspaceId = workspace.id;

    // Self-clean leftovers from earlier failed runs (shared spike DB).
    await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await prisma.gateway.deleteMany({ where: { serialNumber: { in: ["sn-spike-gw", "sn-spike-gw-pool"] } } });
    const stale = await prisma.site.findFirst({ where: { workspaceId, name: "Bucket Spike Site" }, select: { id: true } });
    if (stale) {
      await prisma.order.deleteMany({ where: { siteId: stale.id } });
      await prisma.site.delete({ where: { id: stale.id } });
    }

    siteB = await prisma.site.create({ data: { workspaceId, name: "Bucket Spike Site" }, select: { id: true } });
    wc1 = await prisma.workcenter.create({ data: { siteId: siteB.id, name: "spike-wc-1" }, select: { id: true } });
    wc2 = await prisma.workcenter.create({ data: { siteId: siteB.id, name: "spike-wc-2" }, select: { id: true } });
    s1 = await prisma.station.create({
      data: { siteId: siteB.id, workcenterId: wc1.id, name: "spike-s1" },
      select: { id: true },
    });
    s2 = await prisma.station.create({
      data: { siteId: siteB.id, workcenterId: wc2.id, name: "spike-s2" },
      select: { id: true },
    });
    // A station with no workcenter has no bucket — owner territory.
    sNull = await prisma.station.create({ data: { siteId: siteB.id, name: "spike-s-null" }, select: { id: true } });
    gatewayB = await prisma.gateway.create({
      data: { name: "spike-gw", serialNumber: "sn-spike-gw", siteId: siteB.id },
      select: { id: true },
    });
    gatewayPool = await prisma.gateway.create({
      data: { name: "spike-gw-pool", serialNumber: "sn-spike-gw-pool" },
      select: { id: true },
    });

    // Bucket lifecycle: created WITH the site and workcenters (the
    // migration bootstraps pre-existing rows; the test mirrors the hook).
    const plant = await prisma.bucket.create({
      data: { workspaceId, siteId: siteB.id, kind: "PLANT", name: "Bucket Spike Site" },
      select: { id: true },
    });
    wc1Bucket = await prisma.bucket.create({
      data: { workspaceId, siteId: siteB.id, kind: "WORKCENTER", workcenterId: wc1.id, name: "spike-wc-1" },
      select: { id: true },
    });
    await prisma.bucket.create({
      data: { workspaceId, siteId: siteB.id, kind: "WORKCENTER", workcenterId: wc2.id, name: "spike-wc-2" },
      select: { id: true },
    });

    const passwordHash = await hashPassword(PASSWORD);
    const mkUser = async (email: string, accesses: Array<{ bucketId: string; tier: "VIEW" | "WORK" | "MANAGE" | "ADMIN" }>) => {
      const user = await prisma.user.create({ data: { email, passwordHash, firstName: "Spike", status: "ACTIVE" } });
      const membership = await prisma.workspaceMembership.create({ data: { userId: user.id, workspaceId } });
      for (const a of accesses) {
        await prisma.bucketAccess.create({ data: { bucketId: a.bucketId, membershipId: membership.id, tier: a.tier } });
      }
      return membership.id;
    };

    await mkUser(EMAILS.crew, [{ bucketId: wc1Bucket.id, tier: "WORK" }]);
    await mkUser(EMAILS.member, [{ bucketId: plant.id, tier: "VIEW" }]);
    await mkUser(EMAILS.manager, [{ bucketId: plant.id, tier: "MANAGE" }]);
    await mkUser(EMAILS.padmin, [{ bucketId: plant.id, tier: "ADMIN" }]);
    await mkUser(EMAILS.plain, []);
    // Owner = reserved ownership (owner:all role), the Basecamp account owner.
    const ownerMembership = await mkUser(EMAILS.owner, []);
    const ownerRole = await prisma.role.findFirstOrThrow({
      where: { workspaceId, name: "Company Administrator", isSystem: true },
      select: { id: true },
    });
    await prisma.roleAssignment.create({
      data: { membershipId: ownerMembership, roleId: ownerRole.id, siteId: null },
    });

    for (const key of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      tokens[key] = await loginFrom(EMAILS[key]);
    }
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    if (gatewayB) await prisma.gateway.deleteMany({ where: { id: { in: [gatewayB.id, gatewayPool.id] } } });
    if (siteB) {
      await prisma.order.deleteMany({ where: { siteId: siteB.id } });
      await prisma.site.deleteMany({ where: { id: siteB.id } });
    }
    await server.close();
  });

  it("crew: operate the cell, read the plant's common things, write nothing plant-wide", async () => {
    expect((await rpcCall(server, "station/get", { id: s1.id }, tokens.crew)).statusCode).toBe(200);
    expect((await rpcCall(server, "station/get", { id: s2.id }, tokens.crew)).statusCode).toBe(403);
    expect((await rpcCall(server, "station/changeJob", { stationId: s1.id, jobId: null }, tokens.crew)).statusCode).toBe(
      200,
    );
    // Configuring the station is MANAGE — plant managers, not the crew.
    expect((await rpcCall(server, "station/update", { id: s1.id, description: "no" }, tokens.crew)).statusCode).toBe(403);
    // The membership hook: any workcenter access makes you a plant member,
    // so the crew reads catalogs AND the order book (a named v3 delta).
    expect((await rpcCall(server, "product/list", { siteId: siteB.id }, tokens.crew)).statusCode).toBe(200);
    expect((await rpcCall(server, "order/list", { siteId: siteB.id }, tokens.crew)).statusCode).toBe(200);
    expect(
      (await rpcCall(server, "order/create", { siteId: siteB.id, orderNumber: "spk-crew" }, tokens.crew)).statusCode,
    ).toBe(403);
  });

  it("member: read the common things, see no floor, write nothing", async () => {
    expect((await rpcCall(server, "order/list", { siteId: siteB.id }, tokens.member)).statusCode).toBe(200);
    expect((await rpcCall(server, "product/list", { siteId: siteB.id }, tokens.member)).statusCode).toBe(200);
    expect((await rpcCall(server, "station/get", { id: s1.id }, tokens.member)).statusCode).toBe(403);
    expect(
      (await rpcCall(server, "order/create", { siteId: siteB.id, orderNumber: "spk-m" }, tokens.member)).statusCode,
    ).toBe(403);
    expect((await rpcCall(server, "gateway/update", { id: gatewayB.id, name: "x" }, tokens.member)).statusCode).toBe(403);
  });

  it("manager: write the plant and everything in it (the cascade), but not the reserved shelf", async () => {
    expect(
      (await rpcCall(server, "order/create", { siteId: siteB.id, orderNumber: "spk-1" }, tokens.manager)).statusCode,
    ).toBe(200);
    expect(
      (await rpcCall(server, "gateway/update", { id: gatewayB.id, name: "spike-gw-2" }, tokens.manager)).statusCode,
    ).toBe(200);
    // Station config in ANY workcenter, with zero per-cell access rows.
    expect(
      (await rpcCall(server, "station/update", { id: s1.id, description: "cascade" }, tokens.manager)).statusCode,
    ).toBe(200);
    // Rosters are reserved.
    expect((await rpcCall(server, "bucket/members", { bucketId: wc1Bucket.id }, tokens.manager)).statusCode).toBe(403);
    // The unassigned pool is unhomed — owner territory, even for managers.
    expect((await rpcCall(server, "gateway/update", { id: gatewayPool.id, name: "x" }, tokens.manager)).statusCode).toBe(
      404,
    );
  });

  it("plant admin: the reserved shelf (rosters), plus everything a manager can do", async () => {
    const roster = await rpcCall(server, "bucket/members", { bucketId: wc1Bucket.id }, tokens.padmin);
    expect(roster.statusCode).toBe(200);
    const emails = (roster.json as { members: Array<{ user: { email: string } | null }> }).members.map(
      (m) => m.user?.email,
    );
    expect(emails).toContain(EMAILS.crew);
    expect(
      (await rpcCall(server, "order/create", { siteId: siteB.id, orderNumber: "spk-2" }, tokens.padmin)).statusCode,
    ).toBe(200);
  });

  it("owner: bypasses buckets and owns the unhomed rows", async () => {
    expect(
      (await rpcCall(server, "gateway/update", { id: gatewayPool.id, name: "spike-pool-2" }, tokens.owner)).statusCode,
    ).toBe(200);
    expect((await rpcCall(server, "station/get", { id: sNull.id }, tokens.owner)).statusCode).toBe(200);
    // For everyone else an unhomed row simply does not exist.
    expect((await rpcCall(server, "station/get", { id: sNull.id }, tokens.crew)).statusCode).toBe(404);
    expect((await rpcCall(server, "station/get", { id: sNull.id }, tokens.manager)).statusCode).toBe(404);
  });

  it("the site directory is the union of my buckets' sites", async () => {
    const crewTree = await rpcCall(server, "site/tree", {}, tokens.crew);
    expect(crewTree.statusCode).toBe(200);
    expect((crewTree.json as Array<{ id: string }>).map((s) => s.id)).toEqual([siteB.id]);
    expect(((await rpcCall(server, "site/tree", {}, tokens.plain)).json as unknown[]).length).toBe(0);
  });

  it("bucket/list shows the whole access story, hook and cascade included", async () => {
    const crewList = await rpcCall(server, "bucket/list", {}, tokens.crew);
    const crewBuckets = (crewList.json as { buckets: Array<{ kind: string; tier: string }> }).buckets;
    expect(crewBuckets.map((b) => `${b.kind}:${b.tier}`).sort()).toEqual(["PLANT:VIEW", "WORKCENTER:WORK"]);

    const managerList = await rpcCall(server, "bucket/list", {}, tokens.manager);
    const managerBuckets = (managerList.json as { buckets: Array<{ kind: string; tier: string }> }).buckets;
    expect(managerBuckets.map((b) => `${b.kind}:${b.tier}`).sort()).toEqual([
      "PLANT:MANAGE",
      "WORKCENTER:MANAGE",
      "WORKCENTER:MANAGE",
    ]);
  });
});
