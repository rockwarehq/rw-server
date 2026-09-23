import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

// ─── SPIKE: Basecamp-bucket access model ────────────────────────────────
// Exercises the whole model end to end: buckets as the only access
// container, membership tiers as the only vocabulary, one gate.
// Runs ONLY against the dedicated spike database.

const PASSWORD = "bucket-spike-password-1";
const EMAILS = {
  worker: "bucket-worker@test.local",
  office: "bucket-office@test.local",
  engineer: "bucket-engineer@test.local",
  plain: "bucket-plain@test.local",
  admin: "bucket-admin@test.local",
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("bucket spike (Tier 2)", () => {
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
    await prisma.site.deleteMany({ where: { workspaceId, name: "Bucket Spike Site" } });

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
    // The escape-hatch case: a station with no workcenter has NO bucket.
    sNull = await prisma.station.create({ data: { siteId: siteB.id, name: "spike-s-null" }, select: { id: true } });
    gatewayB = await prisma.gateway.create({
      data: { name: "spike-gw", serialNumber: "sn-spike-gw", siteId: siteB.id },
      select: { id: true },
    });
    gatewayPool = await prisma.gateway.create({
      data: { name: "spike-gw-pool", serialNumber: "sn-spike-gw-pool" },
      select: { id: true },
    });

    // Bucket lifecycle: in a real adoption these are created WITH the site
    // and workcenter (Basecamp creates the bucket with the project). The
    // migration bootstraps existing rows; the test mirrors the create hook.
    const bucket = (kind: "PLANT_OFFICE" | "PLANT_LIBRARY" | "PLANT_CONFIG" | "WORKCENTER", opts: { workcenterId?: string; name: string }) =>
      prisma.bucket.create({
        data: { workspaceId, siteId: siteB.id, kind, workcenterId: opts.workcenterId ?? null, name: opts.name },
        select: { id: true },
      });
    wc1Bucket = await bucket("WORKCENTER", { workcenterId: wc1.id, name: "spike-wc-1" });
    await bucket("WORKCENTER", { workcenterId: wc2.id, name: "spike-wc-2" });
    const office = await bucket("PLANT_OFFICE", { name: "Office" });
    await bucket("PLANT_LIBRARY", { name: "Library" });
    const config = await bucket("PLANT_CONFIG", { name: "Config" });

    const passwordHash = await hashPassword(PASSWORD);
    const mkUser = async (email: string, accesses: Array<{ bucketId: string; tier: "VIEW" | "WORK" | "MANAGE" }>) => {
      const user = await prisma.user.create({ data: { email, passwordHash, firstName: "Spike", status: "ACTIVE" } });
      const membership = await prisma.workspaceMembership.create({ data: { userId: user.id, workspaceId } });
      for (const a of accesses) {
        await prisma.bucketAccess.create({ data: { bucketId: a.bucketId, membershipId: membership.id, tier: a.tier } });
      }
      return membership.id;
    };

    await mkUser(EMAILS.worker, [{ bucketId: wc1Bucket.id, tier: "WORK" }]);
    await mkUser(EMAILS.office, [{ bucketId: office.id, tier: "VIEW" }]);
    await mkUser(EMAILS.engineer, [{ bucketId: config.id, tier: "MANAGE" }]);
    await mkUser(EMAILS.plain, []);
    // Admin = reserved ownership (owner:all role), the Basecamp account owner.
    const adminMembership = await mkUser(EMAILS.admin, []);
    const ownerRole = await prisma.role.findFirstOrThrow({
      where: { workspaceId, name: "Company Administrator", isSystem: true },
      select: { id: true },
    });
    await prisma.roleAssignment.create({
      data: { membershipId: adminMembership, roleId: ownerRole.id, siteId: null },
    });

    for (const key of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      tokens[key] = await loginFrom(EMAILS[key]);
    }
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await prisma.gateway.deleteMany({ where: { id: { in: [gatewayB.id, gatewayPool.id] } } });
    await prisma.site.deleteMany({ where: { id: siteB.id } });
    await server.close();
  });

  it("a WORK member operates their own bucket and nothing else", async () => {
    expect((await rpcCall(server, "station/get", { id: s1.id }, tokens.worker)).statusCode).toBe(200);
    expect((await rpcCall(server, "station/get", { id: s2.id }, tokens.worker)).statusCode).toBe(403);
    // Operating is WORK; configuring is MANAGE.
    const change = await rpcCall(server, "station/changeJob", { stationId: s1.id, jobId: null }, tokens.worker);
    expect(change.statusCode).toBe(200);
    const update = await rpcCall(server, "station/update", { id: s1.id, description: "nope" }, tokens.worker);
    expect(update.statusCode).toBe(403);
  });

  it("any bucket at a site confers Library VIEW (the catalog hook)", async () => {
    expect((await rpcCall(server, "product/list", { siteId: siteB.id }, tokens.worker)).statusCode).toBe(200);
    expect((await rpcCall(server, "product/list", { siteId: siteB.id }, tokens.engineer)).statusCode).toBe(200);
    // No bucket anywhere → no Library, no catalogs.
    expect((await rpcCall(server, "product/list", { siteId: siteB.id }, tokens.plain)).statusCode).toBe(403);
  });

  it("Office bucket splits planning from the floor", async () => {
    expect((await rpcCall(server, "order/list", { siteId: siteB.id }, tokens.office)).statusCode).toBe(200);
    expect((await rpcCall(server, "order/list", { siteId: siteB.id }, tokens.worker)).statusCode).toBe(403);
    // VIEW can look, only WORK can create.
    const denied = await rpcCall(server, "order/create", { siteId: siteB.id, orderNumber: "spk-1" }, tokens.office);
    expect(denied.statusCode).toBe(403);
    expect((await rpcCall(server, "station/get", { id: s1.id }, tokens.office)).statusCode).toBe(403);
  });

  it("Config bucket MANAGE gates equipment; the unassigned pool is unbucketed", async () => {
    const ok = await rpcCall(server, "gateway/update", { id: gatewayB.id, name: "spike-gw-2" }, tokens.engineer);
    expect(ok.statusCode).toBe(200);
    const notEngineer = await rpcCall(server, "gateway/update", { id: gatewayB.id, name: "x" }, tokens.worker);
    expect(notEngineer.statusCode).toBe(403);
    // A null-site gateway has no bucket: nobody can touch it here — not
    // even ownership. Real adoption must give the pool a home (an HQ
    // bucket) or forbid unhomed rows.
    const pool = await rpcCall(server, "gateway/update", { id: gatewayPool.id, name: "x" }, tokens.admin);
    expect(pool.statusCode).toBe(403);
  });

  it("an unbucketed row is invisible to EVERYONE — the escape hatch is gone", async () => {
    expect((await rpcCall(server, "station/get", { id: sNull.id }, tokens.worker)).statusCode).toBe(404);
    expect((await rpcCall(server, "station/get", { id: sNull.id }, tokens.admin)).statusCode).toBe(404);
  });

  it("reserved ownership bypasses buckets, like the Basecamp account owner", async () => {
    expect((await rpcCall(server, "station/get", { id: s1.id }, tokens.admin)).statusCode).toBe(200);
    expect((await rpcCall(server, "order/list", { siteId: siteB.id }, tokens.admin)).statusCode).toBe(200);
    expect((await rpcCall(server, "gateway/update", { id: gatewayB.id, name: "spike-gw" }, tokens.admin)).statusCode).toBe(
      200,
    );
  });

  it("the site directory is the union of my buckets' sites", async () => {
    const workerTree = await rpcCall(server, "site/tree", {}, tokens.worker);
    expect(workerTree.statusCode).toBe(200);
    const workerSites = (workerTree.json as Array<{ id: string }>).map((s) => s.id);
    expect(workerSites).toEqual([siteB.id]);

    const plainTree = await rpcCall(server, "site/tree", {}, tokens.plain);
    expect((plainTree.json as unknown[]).length).toBe(0);
  });

  it("bucket/list is the whole 'my access' surface; members needs MANAGE", async () => {
    const mine = await rpcCall(server, "bucket/list", {}, tokens.worker);
    expect(mine.statusCode).toBe(200);
    const buckets = (mine.json as { buckets: Array<{ kind: string; tier: string }> }).buckets;
    expect(buckets.map((b) => `${b.kind}:${b.tier}`).sort()).toEqual(["PLANT_LIBRARY:VIEW", "WORKCENTER:WORK"]);

    // Roster: WORK is not enough to see who's in the bucket.
    const denied = await rpcCall(server, "bucket/members", { bucketId: wc1Bucket.id }, tokens.worker);
    expect(denied.statusCode).toBe(403);
    const roster = await rpcCall(server, "bucket/members", { bucketId: wc1Bucket.id }, tokens.admin);
    expect(roster.statusCode).toBe(200);
    const emails = (roster.json as { members: Array<{ user: { email: string } | null }> }).members.map(
      (m) => m.user?.email,
    );
    expect(emails).toContain(EMAILS.worker);
  });
});
