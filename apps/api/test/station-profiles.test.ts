import prisma from "@rw/db";
import { complete as completeCycle } from "@rw/services/cycle/cycle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

// Station profiles (ADR-0017), end to end over RPC: the profile catalog,
// stations following a profile, jobs made for a profile, where a job can run
// (kind + labels), planning speed, and what a recorded cycle earns.

const ADMIN_EMAIL = "sp-admin@test.local";
const READER_EMAIL = "sp-reader@test.local";
const PASSWORD = "sp-test-password-1";
const P = "sp-test";

type Profile = {
  id: string;
  name: string;
  cycleMode: string;
  quantityUnit: string;
  signalAmount: number | null;
  standardCycle: number | null;
  standardRate: number | null;
  usage: { stations: number; jobs: number };
};
type StationJson = {
  id: string;
  currentVersion: {
    profileId: string | null;
    speedFromProfile: boolean;
    cycleMode: string;
    quantityUnit: string;
    standardQuantity: string | number | null;
    standardCycle: string | number | null;
    standardRate: string | number | null;
  };
};
type JobJson = {
  id: string;
  currentVersion: {
    profileId: string | null;
    standardCycle: string | number | null;
    standardRate: string | number | null;
    standardRateUnit: string;
  };
};

const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

describe.skipIf(!process.env.TEST_DATABASE_URL)("station profiles", () => {
  let server: TestServer;
  let siteId: string;
  let admin: string;
  let reader: string;
  const stationIds: string[] = [];
  const jobIds: string[] = [];
  const productIds: string[] = [];
  let labelId: string | null = null;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    const site = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } });
    siteId = site.id;
    await makeUser(ADMIN_EMAIL, PASSWORD, { plants: [{ siteId, level: "ADMIN" }] });
    await makeUser(READER_EMAIL, PASSWORD, { plants: [{ siteId, level: "VIEW" }] });
    admin = (await loginAs(server, ADMIN_EMAIL, PASSWORD)).accessToken;
    reader = (await loginAs(server, READER_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.inventoryItem.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.cycle.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.stationStateLog.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.stationJobLog.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.labelFilter.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.station.deleteMany({ where: { id: { in: stationIds } } });
    await prisma.job.updateMany({ where: { id: { in: jobIds } }, data: { currentVersionId: null } });
    await prisma.jobProduct.updateMany({ where: { jobId: { in: jobIds } }, data: { currentVersionId: null } });
    await prisma.jobProductVersion.deleteMany({ where: { jobProduct: { jobId: { in: jobIds } } } });
    await prisma.jobProduct.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.jobVersion.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.stockItem.deleteMany({ where: { stockableType: "PRODUCT", stockableId: { in: productIds } } });
    await prisma.product.updateMany({ where: { id: { in: productIds } }, data: { currentVersionId: null } });
    await prisma.productVersion.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.stationProfile.deleteMany({ where: { siteId, name: { startsWith: P } } });
    if (labelId) await prisma.label.delete({ where: { id: labelId } });
    await prisma.user.deleteMany({ where: { email: { in: [ADMIN_EMAIL, READER_EMAIL] } } });
    await server.close();
  });

  async function call<T>(path: string, input: unknown, token = admin, status = 200): Promise<T> {
    const res = await rpcCall(server, path, input, token);
    expect(res.statusCode, `${path} → ${JSON.stringify(res.json)}`).toBe(status);
    return res.json as T;
  }
  const profile = (input: Record<string, unknown>) => call<Profile>("stationProfile/create", { siteId, ...input });
  async function station(name: string, input: Record<string, unknown>) {
    const s = await call<StationJson>("station/create", { siteId, name: `${P}-${name}`, ...input });
    stationIds.push(s.id);
    return s;
  }
  async function job(name: string, input: Record<string, unknown>) {
    const j = await call<JobJson>("job/create", { siteId, name: `${P}-${name}`, ...input });
    jobIds.push(j.id);
    return j;
  }

  let press: Profile;
  let extruder100: Profile;
  let extruder50: Profile;
  let header: Profile;

  it("profile catalog: create per kind, validation, duplicate name, permissions", async () => {
    press = await profile({ name: `${P}-press`, cycleMode: "DISCRETE", standardCycle: 28 });
    extruder100 = await profile({
      name: `${P}-extruder-100`,
      cycleMode: "QUANTITY_PER_CYCLE",
      quantityUnit: "ft",
      signalAmount: 100,
      standardRate: 45,
      standardRateUnit: "ft",
    });
    extruder50 = await profile({
      name: `${P}-extruder-50`,
      cycleMode: "QUANTITY_PER_CYCLE",
      quantityUnit: "ft",
      signalAmount: 50,
      standardRate: 45,
    });
    header = await profile({
      name: `${P}-header`,
      cycleMode: "QUANTITY_PER_INTERVAL",
      quantityUnit: "ea",
      signalInterval: 60,
      countedAs: "OUTPUT",
      standardRate: 400,
    });
    expect(extruder100.signalAmount).toBe(100);

    // Count by amount needs an amount per signal.
    await call("stationProfile/create", { siteId, name: `${P}-bad`, cycleMode: "QUANTITY_PER_CYCLE", quantityUnit: "ft" }, admin, 400);
    // A rate in pounds can't fit a machine that counts feet.
    await call(
      "stationProfile/create",
      { siteId, name: `${P}-bad2`, cycleMode: "QUANTITY_PER_CYCLE", quantityUnit: "ft", signalAmount: 1, standardRate: 3, standardRateUnit: "lb" },
      admin,
      400,
    );
    await call("stationProfile/create", { siteId, name: `${P}-press`, cycleMode: "DISCRETE" }, admin, 409);
    await call("stationProfile/create", { siteId, name: `${P}-x`, cycleMode: "DISCRETE" }, reader, 403);
    const list = await call<{ data: Profile[] }>("stationProfile/list", { siteId }, reader);
    expect(list.data.map((p) => p.name)).toContain(`${P}-press`);
  });

  let pressA: StationJson;
  let pressB: StationJson;
  let line: StationJson;

  it("a station copies how it counts from its profile, and may keep its own speed", async () => {
    pressA = await station("press-a", { profileId: press.id });
    pressB = await station("press-b", { profileId: press.id, standardCycle: 40 });
    line = await station("line", { profileId: extruder100.id });

    expect(pressA.currentVersion).toMatchObject({ profileId: press.id, speedFromProfile: true, cycleMode: "DISCRETE" });
    expect(num(pressA.currentVersion.standardCycle)).toBe(28);
    expect(pressB.currentVersion.speedFromProfile).toBe(false);
    expect(num(pressB.currentVersion.standardCycle)).toBe(40);
    expect(line.currentVersion).toMatchObject({ cycleMode: "QUANTITY_PER_CYCLE", quantityUnit: "ft" });
    expect(num(line.currentVersion.standardQuantity)).toBe(100);
    expect(num(line.currentVersion.standardRate)).toBe(45);

    // How it counts belongs to the profile.
    await call("station/update", { id: line.id, standardQuantity: 25 }, admin, 400);
    // Sending the same values (an older client's full form) is fine.
    await call("station/update", { id: line.id, standardQuantity: 100, cycleMode: "QUANTITY_PER_CYCLE" });
  });

  it("a profile edit reaches stations that follow it; a station with its own speed keeps it", async () => {
    await call("stationProfile/update", { id: press.id, standardCycle: 30 });
    const a = await call<StationJson>("station/get", { id: pressA.id });
    const b = await call<StationJson>("station/get", { id: pressB.id });
    expect(num(a.currentVersion.standardCycle)).toBe(30);
    expect(num(b.currentVersion.standardCycle)).toBe(40);

    // Going back to the profile's speed.
    const back = await call<StationJson>("station/update", { id: pressB.id, useProfileSpeed: true });
    expect(back.currentVersion.speedFromProfile).toBe(true);
    expect(num(back.currentVersion.standardCycle)).toBe(30);
  });

  it("a profile in use can't change how it counts", async () => {
    await call("stationProfile/update", { id: press.id, cycleMode: "QUANTITY_PER_INTERVAL", quantityUnit: "ea", signalInterval: 60 }, admin, 409);
    await call("stationProfile/update", { id: extruder100.id, quantityUnit: "lb", standardRateUnit: "lb" }, admin, 409);
  });

  let moldJob: JobJson;
  let lineJob: JobJson;

  it("a new job gets its profile's usual speed, in the profile's shape", async () => {
    moldJob = await job("mold", { profileId: press.id });
    expect(moldJob.currentVersion.profileId).toBe(press.id);
    expect(num(moldJob.currentVersion.standardCycle)).toBe(30);

    lineJob = await job("line", { profileId: extruder100.id, standardRate: 15.24, standardRateUnit: "m" });
    expect(num(lineJob.currentVersion.standardRate)).toBeCloseTo(15.24);
    expect(lineJob.currentVersion.standardCycle).toBeNull();

    // A job's speed must fit its profile's unit.
    await call("job/update", { id: lineJob.id, standardRate: 3, standardRateUnit: "kg" }, admin, 400);
    // Same kind (another extruder) is fine; another kind is not.
    await call("job/update", { id: lineJob.id, profileId: extruder50.id });
    await call("job/update", { id: lineJob.id, profileId: press.id }, admin, 409);
  });

  it("where a job can run: kind and the station's job label filter", async () => {
    // Extruder job on a press: wrong kind.
    const wrong = await rpcCall(server, "station/changeJob", { stationId: pressA.id, jobId: lineJob.id }, admin);
    expect(wrong.statusCode).toBe(409);

    // The 50 ft job runs on the 100 ft line: same kind, same units.
    await call("station/changeJob", { stationId: line.id, jobId: lineJob.id });

    // A job filter on press B: the mold job lacks the label.
    const label = await prisma.label.create({ data: { siteId, name: `${P}-500T` }, select: { id: true } });
    labelId = label.id;
    await call("station/setLabelFilter", { stationId: pressB.id, target: "JOB", labelIds: [label.id] });
    const blocked = await rpcCall(server, "station/changeJob", { stationId: pressB.id, jobId: moldJob.id }, admin);
    expect(blocked.statusCode).toBe(409);

    const where = await call<{ stationId: string; reasons: { code: string }[] }[]>("job/eligibleStations", {
      id: moldJob.id,
    });
    const byId = new Map(where.map((r) => [r.stationId, r.reasons.map((x) => x.code)]));
    expect(byId.get(pressA.id)).toEqual([]);
    expect(byId.get(pressB.id)).toEqual(["LABEL_FILTER_MISMATCH"]);
    expect(byId.get(line.id)).toEqual(["PROFILE_MISMATCH"]);

    const runnable = await call<{ data: { jobId: string }[] }>("station/eligibleJobs", { stationId: pressA.id, limit: 0 });
    const ids = runnable.data.map((j) => j.jobId);
    expect(ids).toContain(moldJob.id);
    expect(ids).not.toContain(lineJob.id);
  });

  it("planning: a job's output per hour with no station", async () => {
    const plan = await call<{ rate: { outputPerHour: number; source: string } }>("job/planning", { id: lineJob.id });
    // 15.24 m/min = 50 ft/min = 3,000 ft/hour.
    expect(plan.rate.source).toBe("JOB");
    expect(plan.rate.outputPerHour).toBeCloseTo(3000, 3);
  });

  it("a recorded cycle earns quantity × time per unit at the job's speed", async () => {
    const t0 = new Date(Date.now() - 60_000);
    const first = await completeCycle({ stationId: line.id, timestamp: t0, jobId: lineJob.id, quantity: 100 });
    if ("error" in first && first.error) throw new Error(String(first.error));
    const second = await completeCycle({
      stationId: line.id,
      timestamp: new Date(t0.getTime() + 30_000),
      jobId: lineJob.id,
      quantity: 100,
    });
    if ("error" in second && second.error) throw new Error(String(second.error));
    const cycle = await prisma.cycle.findUniqueOrThrow({ where: { id: (second as { data: { id: string } }).data.id } });
    // 100 ft at 50 ft/min = 120 s earned.
    expect(num(cycle.standardCycle as never)).toBeCloseTo(120, 2);
    expect(cycle.quantityUnit).toBe("ft");
  });

  it("a finished-parts clock feeds one product at ×1", async () => {
    const hj = await job("header", { profileId: header.id });
    const make = async (sku: string) => {
      const product = await prisma.product.create({ data: { siteId }, select: { id: true } });
      productIds.push(product.id);
      const v = await prisma.productVersion.create({ data: { productId: product.id, version: 1, sku }, select: { id: true } });
      await prisma.product.update({ where: { id: product.id }, data: { currentVersionId: v.id } });
      return product.id;
    };
    const p1 = await make(`${P}-sku-1`);
    const p2 = await make(`${P}-sku-2`);
    await call("job/addItem", { jobId: hj.id, productId: p1, quantity: 2 }, admin, 409);
    await call("job/addItem", { jobId: hj.id, productId: p1, quantity: 1 });
    await call("job/addItem", { jobId: hj.id, productId: p2, quantity: 1 }, admin, 409);
  });

  it("every site has a Discrete default; no profile given means the default", async () => {
    const def = await call<Profile & { isDefault: boolean }>("stationProfile/getDefault", { siteId }, reader);
    expect(def).toMatchObject({ name: "Discrete", cycleMode: "DISCRETE", isDefault: true });
    const list = await call<{ data: (Profile & { isDefault: boolean })[] }>("stationProfile/list", { siteId });
    expect(list.data[0]).toMatchObject({ id: def.id, isDefault: true });

    // A plain station and a plain job need no setup at all.
    const plain = await station("plain", { standardCycle: 22 });
    expect(plain.currentVersion).toMatchObject({ profileId: def.id, cycleMode: "DISCRETE" });
    expect(num(plain.currentVersion.standardCycle)).toBe(22);
    const plainJob = await job("plain", { standardCycle: 18 });
    expect(plainJob.currentVersion.profileId).toBe(def.id);
    expect(num(plainJob.currentVersion.standardCycle)).toBe(18);
    await call("station/changeJob", { stationId: plain.id, jobId: plainJob.id });

    // A job that arrives with a rate is for another kind of machine: no default.
    const rated = await job("rated", { standardRate: 40, standardRateUnit: "ft" });
    expect(rated.currentVersion.profileId).toBeNull();

    // The default is fixed: no edits at all (not even a rename), no archive.
    await call("stationProfile/update", { id: def.id, name: "Molding" }, admin, 409);
    await call("stationProfile/update", { id: def.id, standardCycle: 30 }, admin, 409);
    await call("stationProfile/update", { id: def.id, cycleMode: "QUANTITY_PER_CYCLE", quantityUnit: "ft", signalAmount: 1 }, admin, 409);
    await call("stationProfile/archive", { id: def.id }, admin, 409);
  });

  it("a profile used by stations can't be archived", async () => {
    await call("stationProfile/archive", { id: press.id }, admin, 409);
  });
});
