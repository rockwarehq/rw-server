import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlantBucket, ensureWorkcenterBucket, makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const EMAIL = "shared-plant-crew@test.local";
const MEMBER_EMAIL = "shared-plant-member@test.local";
const PASSWORD = "shared-plant-pass-1";

// Tier 2: plant data vs workcenter data (see packages/auth/src/iam/rows.ts).
// A crew member of workcenter A can see plant jobs and put one to work on
// their own station, but cannot edit the job, and cannot reach workcenter B's
// stations or floor records (cycles, inventory items, logs, metrics,
// recaps). A plant member (plant MANAGE) edits plant data but reaches no
// workcenter it was not given and does no shop-floor setup.
describe.skipIf(!process.env.TEST_DATABASE_URL)("shared plant data (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let token: string;
  let memberToken: string;
  const wc = { a: "", b: "" };
  let jobId: string;
  const station = { a: "", b: "" };
  const cycle = { a: "", b: "" };
  const item = { a: "", b: "" };

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    const anchor = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { workspaceId: true } });
    const workspaceId = anchor.workspaceId;
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL, MEMBER_EMAIL] } } });

    // Unique per run: plant rows (jobs, products) keep the site from being deleted.
    const siteName = `Shared Plant Site ${randomUUID()}`;
    siteId = (await prisma.site.create({ data: { workspaceId, name: siteName }, select: { id: true } })).id;
    await ensurePlantBucket(workspaceId, siteId, siteName);
    const wcA = (await prisma.workcenter.create({ data: { siteId, name: "sp-a" }, select: { id: true } })).id;
    const wcB = (await prisma.workcenter.create({ data: { siteId, name: "sp-b" }, select: { id: true } })).id;
    wc.a = wcA;
    wc.b = wcB;
    await ensureWorkcenterBucket(workspaceId, siteId, wcA, "sp-a");
    await ensureWorkcenterBucket(workspaceId, siteId, wcB, "sp-b");
    station.a = (await prisma.station.create({ data: { siteId, workcenterId: wcA, name: "sp-s-a" } })).id;
    station.b = (await prisma.station.create({ data: { siteId, workcenterId: wcB, name: "sp-s-b" } })).id;

    // A plant job with a current version, and a product to record output of.
    jobId = (await prisma.job.create({ data: { siteId } })).id;
    const jobVersion = await prisma.jobVersion.create({ data: { jobId, version: 1, name: "sp-job" } });
    await prisma.job.update({ where: { id: jobId }, data: { currentVersionId: jobVersion.id } });
    const product = await prisma.product.create({ data: { siteId } });
    const productVersion = await prisma.productVersion.create({
      data: { productId: product.id, version: 1, sku: "sp-sku" },
    });

    // One cycle and one inventory item on each workcenter's station.
    for (const key of ["a", "b"] as const) {
      const workcenterId = key === "a" ? wcA : wcB;
      cycle[key] = (
        await prisma.cycle.create({
          data: {
            siteId,
            stationId: station[key],
            workcenterId,
            jobVersionId: jobVersion.id,
            cycleStatus: "GOOD",
            start: new Date(),
          },
        })
      ).id;
      item[key] = (
        await prisma.inventoryItem.create({
          data: { cycleId: cycle[key], productVersionId: productVersion.id, workcenterId },
        })
      ).id;
    }

    await makeUser(workspaceId, EMAIL, PASSWORD, { workcenters: [{ workcenterId: wcA, level: "MANAGE" }] });
    token = (await loginAs(server, EMAIL, PASSWORD)).accessToken;
    await makeUser(workspaceId, MEMBER_EMAIL, PASSWORD, { plants: [{ siteId, level: "MANAGE" }] });
    memberToken = (await loginAs(server, MEMBER_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL, MEMBER_EMAIL] } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: [item.a, item.b] } } });
    await prisma.cycle.deleteMany({ where: { id: { in: [cycle.a, cycle.b] } } });
    await server.close();
  });

  it("crew can see plant jobs", async () => {
    expect((await rpcCall(server, "job/get", { id: jobId }, token)).statusCode).toBe(200);
  });

  it("crew can put a plant job to work on their own station", async () => {
    const res = await rpcCall(server, "station/changeJob", { stationId: station.a, jobId }, token);
    expect(res.statusCode).toBe(200);
  });

  it("crew cannot edit the plant job itself", async () => {
    const res = await rpcCall(server, "job/update", { id: jobId, name: "renamed" }, token);
    expect(res.statusCode).toBe(403);
  });

  it("crew cannot change another workcenter's station", async () => {
    const res = await rpcCall(server, "station/changeJob", { stationId: station.b, jobId }, token);
    expect(res.statusCode).toBe(403);
  });

  it("crew see their own floor records and not another workcenter's", async () => {
    expect((await rpcCall(server, "inventory/get", { id: item.a }, token)).statusCode).toBe(200);
    expect((await rpcCall(server, "inventory/get", { id: item.b }, token)).statusCode).toBe(403);
    expect((await rpcCall(server, "inventory/getByCycle", { cycleId: cycle.a }, token)).statusCode).toBe(200);
    expect((await rpcCall(server, "inventory/getByCycle", { cycleId: cycle.b }, token)).statusCode).toBe(403);
  });

  it("crew cannot read another workcenter's logs; with no filter they get their own", async () => {
    const byStation = await rpcCall(server, "logs/downtimeSearch", { siteId, stationId: station.b }, token);
    expect(byStation.statusCode).toBe(403);
    const byCell = await rpcCall(server, "logs/cycleSearch", { siteId, workCenterId: wc.b }, token);
    expect(byCell.statusCode).toBe(403);
    const own = await rpcCall(server, "logs/cycleSearch", { siteId }, token);
    expect(own.statusCode).toBe(200);
    const ids = (own.json as { data: Array<{ id: string }> }).data.map((row) => row.id);
    expect(ids).not.toContain(cycle.b);
  });

  it("crew cannot read another workcenter's metrics, or the whole plant's", async () => {
    const entities = (entityType: string, entityId: string) => [{ entityType, entityId, granularities: ["SHIFT"] }];
    const other = await rpcCall(server, "metrics/getBuckets", { siteId, entities: entities("WORKCENTER", wc.b) }, token);
    expect(other.statusCode).toBe(403);
    const plant = await rpcCall(server, "metrics/getBuckets", { siteId, entities: entities("SITE", siteId) }, token);
    expect(plant.statusCode).toBe(403);
    const own = await rpcCall(server, "metrics/getBuckets", { siteId, entities: entities("WORKCENTER", wc.a) }, token);
    expect(own.statusCode).toBe(200);
  });

  it("crew cannot read another workcenter's shift recap", async () => {
    const shiftInstanceId = randomUUID();
    const res = await rpcCall(server, "shiftRecap/commentList", { siteId, shiftInstanceId, workCenterId: wc.b }, token);
    expect(res.statusCode).toBe(403);
  });

  it("plant member edits plant data but not shop-floor setup", async () => {
    expect((await rpcCall(server, "job/update", { id: jobId, name: "member-edit" }, memberToken)).statusCode).toBe(200);
    const reason = await rpcCall(server, "statusReason/create", { siteId, name: "sp-reason" }, memberToken);
    expect(reason.statusCode).toBe(403);
  });

  it("plant member reaches no workcenter it was not given", async () => {
    expect((await rpcCall(server, "station/get", { id: station.a }, memberToken)).statusCode).toBe(403);
    expect((await rpcCall(server, "logs/cycleSearch", { siteId }, memberToken)).statusCode).toBe(403);
  });
});
