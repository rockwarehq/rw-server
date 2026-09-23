import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlantBucket, makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";

const FA_EMAIL = "dev-authz-fa@test.local";
const READER_EMAIL = "dev-authz-reader@test.local";
const PASSWORD = "dev-authz-password-1";

// Tier 2: device REST surface (gateways/datasources/points/groups/drivers).
describe.skipIf(!process.env.TEST_DATABASE_URL)("device REST authorization (Tier 2)", () => {
  let server: TestServer;
  let siteA: { id: string };
  let siteB: { id: string };
  let gatewayA: { id: string };
  let gatewayB: { id: string };
  let faToken: string;
  let readerToken: string;

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, token: string, payload?: unknown) =>
    server.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

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
      where: { workspaceId_name: { workspaceId, name: "DevAuthZ Site B" } },
      update: {},
      create: { name: "DevAuthZ Site B", workspaceId },
      select: { id: true },
    });
    // Sites created via raw prisma bypass the service hook that creates
    // the plant bucket — heal it so the container exists.
    await ensurePlantBucket(workspaceId, siteB.id, "DevAuthZ Site B");

    const findOrCreateGateway = async (siteId: string, name: string) => {
      const existing = await prisma.gateway.findFirst({ where: { siteId, name }, select: { id: true } });
      return (
        existing ?? prisma.gateway.create({ data: { name, siteId, serialNumber: `sn-${name}` }, select: { id: true } })
      );
    };
    gatewayA = await findOrCreateGateway(siteA.id, "dev-authz-gw-a");
    gatewayB = await findOrCreateGateway(siteB.id, "dev-authz-gw-b");

    // Bucket-era fixtures. The manager is plant ADMIN at site A (was the
    // "Plant Admin" role). FLIP: gateway/datasource READS are member reads
    // now — the reader needs only plant VIEW at site A, where the key model
    // required a custom configuration:read role.
    await makeUser(FA_EMAIL, PASSWORD, { plants: [{ siteId: siteA.id, level: "ADMIN" }] });
    await makeUser(READER_EMAIL, PASSWORD, { plants: [{ siteId: siteA.id, level: "VIEW" }] });

    faToken = (await loginAs(server, FA_EMAIL, PASSWORD)).accessToken;
    readerToken = (await loginAs(server, READER_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [FA_EMAIL, READER_EMAIL] } } });
    await prisma.gateway.deleteMany({ where: { name: { in: ["dev-authz-gw-a", "dev-authz-gw-b"] } } });
    await prisma.site.deleteMany({ where: { name: "DevAuthZ Site B" } });
    await server.close();
  });

  it("plant members (VIEW) can GET gateways but cannot modify them", async () => {
    const get = await call("GET", `/gateways/${gatewayA.id}`, readerToken);
    expect(get.statusCode).toBe(200);
    const put = await call("PUT", `/gateways/${gatewayA.id}`, readerToken, { name: "nope" });
    expect(put.statusCode).toBe(403);
  });

  it("cross-site gateway access is denied, including the previously unchecked spec route", async () => {
    // The manager holds plant ADMIN at site A only — no access at site B.
    const get = await call("GET", `/gateways/${gatewayB.id}`, faToken);
    expect(get.statusCode).toBe(403);
    const spec = await call("GET", `/gateways/${gatewayB.id}/spec`, faToken);
    expect(spec.statusCode).toBe(403);
  });

  it("gateway credential minting requires plant MANAGE at the gateway's site", async () => {
    const denied = await call("POST", `/gateways/${gatewayB.id}/tokens`, faToken, { name: "x" });
    expect(denied.statusCode).toBe(403);
    const reader = await call("POST", `/gateways/${gatewayA.id}/tokens`, readerToken, { name: "x" });
    expect(reader.statusCode).toBe(403);
  });

  it("moving a gateway requires plant MANAGE at the target site (two-sided)", async () => {
    const res = await call("PUT", `/gateways/${gatewayA.id}`, faToken, { siteId: siteB.id });
    expect(res.statusCode).toBe(403);
  });

  it("remote commands are level-gated: MANAGE queues, members read", async () => {
    const queue = await call("POST", `/gateways/${gatewayA.id}/commands`, readerToken, { command: "restart" });
    expect(queue.statusCode).toBe(403);
    const list = await call("GET", `/gateways/${gatewayA.id}/commands`, readerToken);
    expect(list.statusCode).toBe(200);
  });

  it("the unassigned-gateway pool is an explicit view for plant managers", async () => {
    const pool = await prisma.gateway.create({
      data: { name: "dev-authz-gw-pool", serialNumber: "sn-dev-authz-gw-pool" },
      select: { id: true },
    });
    try {
      // Not visible in a site-scoped list…
      const siteList = await call("GET", `/gateways/?siteId=${siteA.id}`, faToken);
      expect(siteList.statusCode).toBe(200);
      expect((siteList.json() as Array<{ id: string }>).map((g) => g.id)).not.toContain(pool.id);
      // …visible via the explicit pool view for MANAGE held at any plant
      // (ADMIN qualifies)…
      const poolList = await call("GET", "/gateways/?unassigned=true", faToken);
      expect(poolList.statusCode).toBe(200);
      expect((poolList.json() as Array<{ id: string }>).map((g) => g.id)).toContain(pool.id);
      // …and denied for VIEW-only members.
      const readerPool = await call("GET", "/gateways/?unassigned=true", readerToken);
      expect(readerPool.statusCode).toBe(403);
    } finally {
      await prisma.gateway.deleteMany({ where: { id: pool.id } });
    }
  });

  it("datasource listing is scope-filtered and drivers require any plant membership", async () => {
    const list = await call("GET", `/datasources/?siteId=${siteB.id}`, faToken);
    expect(list.statusCode).toBe(403);
    // The driver catalog is global vendor metadata: membership at any site
    // (VIEW anywhere) suffices.
    const drivers = await call("GET", "/drivers/", faToken);
    expect(drivers.statusCode).toBe(200);
  });
});
