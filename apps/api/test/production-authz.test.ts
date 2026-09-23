import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlantBucket, makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const FA_EMAIL = "prod-authz-fa@test.local";
const READER_EMAIL = "prod-authz-reader@test.local";
const PASSWORD = "prod-authz-password-1";
const NONEXISTENT_ID = "00000000-0000-4000-8000-000000000001";

// Tier 2: production/job domain enforcement — representative matrix, not the
// full 22-proc surface. Fixtures live in site B; users are scoped to site A.
describe.skipIf(!process.env.TEST_DATABASE_URL)("production domain authorization (Tier 2)", () => {
  let server: TestServer;
  let siteB: { id: string };
  let orderB: { id: string };
  let jobB: { id: string };
  let toolB: { id: string };
  let faToken: string;
  let readerToken: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    const workspaceId = rockware.workspaceId;
    siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId, name: "ProdAuthZ Site B" } },
      update: {},
      create: { name: "ProdAuthZ Site B", workspaceId },
      select: { id: true },
    });
    // Raw-prisma sites need their plant bucket created by hand.
    await ensurePlantBucket(workspaceId, siteB.id, "ProdAuthZ Site B");

    orderB = await prisma.order.upsert({
      where: { siteId_orderNumber: { siteId: siteB.id, orderNumber: "prod-authz-order" } },
      update: {},
      create: { siteId: siteB.id, orderNumber: "prod-authz-order" },
      select: { id: true },
    });
    // Job/Tool are versioned models — the base row only needs a siteId.
    jobB =
      (await prisma.job.findFirst({ where: { siteId: siteB.id }, select: { id: true } })) ??
      (await prisma.job.create({ data: { siteId: siteB.id }, select: { id: true } }));
    toolB =
      (await prisma.tool.findFirst({ where: { siteId: siteB.id }, select: { id: true } })) ??
      (await prisma.tool.create({ data: { siteId: siteB.id }, select: { id: true } }));

    // Bucket fixtures: FA administers site A's plant; the reader is a plain
    // plant member (VIEW). Neither holds anything at site B.
    await makeUser(workspaceId, FA_EMAIL, PASSWORD, { plants: [{ siteId: rockware.id, level: "ADMIN" }] });
    await makeUser(workspaceId, READER_EMAIL, PASSWORD, { plants: [{ siteId: rockware.id, level: "VIEW" }] });

    faToken = (await loginAs(server, FA_EMAIL, PASSWORD)).accessToken;
    readerToken = (await loginAs(server, READER_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [FA_EMAIL, READER_EMAIL] } } });
    await prisma.order.deleteMany({ where: { siteId: siteB.id } });
    await prisma.job.deleteMany({ where: { siteId: siteB.id } });
    await prisma.tool.deleteMany({ where: { siteId: siteB.id } });
    await prisma.site.deleteMany({ where: { name: "ProdAuthZ Site B" } });
    await server.close();
  });

  it("order.list is scope-filtered: site-A users never see site-B orders", async () => {
    const res = await rpcCall(server, "order/list", { search: "prod-authz-order" }, faToken);
    expect(res.statusCode).toBe(200);
    expect((res.json as { data: Array<{ id: string }> }).data.map((o) => o.id)).not.toContain(orderB.id);
  });

  it("order.list with an out-of-scope siteId is denied", async () => {
    const res = await rpcCall(server, "order/list", { siteId: siteB.id }, faToken);
    expect(res.statusCode).toBe(403);
  });

  it("identifier swaps across the site boundary are denied on get/update", async () => {
    const get = await rpcCall(server, "order/get", { id: orderB.id }, faToken);
    expect(get.statusCode).toBe(403);
    const update = await rpcCall(server, "job/update", { id: jobB.id, name: "nope" }, faToken);
    expect(update.statusCode).toBe(403);
  });

  it("access levels apply within the granted site: a VIEW member cannot write", async () => {
    const res = await rpcCall(server, "order/create", { siteId: siteB.id, orderNumber: "x" }, readerToken);
    expect(res.statusCode).toBe(403);
    const disposition = await rpcCall(server, "disposition/create", { siteId: siteB.id, name: "x" }, readerToken);
    expect(disposition.statusCode).toBe(403);
  });

  it("nonexistent resource ids resolve to NOT_FOUND before permission checks", async () => {
    const res = await rpcCall(server, "tool/get", { id: NONEXISTENT_ID }, faToken);
    expect(res.statusCode).toBe(404);
  });

  it("status catalog writes require MANAGE at the target site", async () => {
    const res = await rpcCall(server, "statusReason/create", { siteId: siteB.id, name: "prod-authz-x" }, faToken);
    expect(res.statusCode).toBe(403);
  });
});
