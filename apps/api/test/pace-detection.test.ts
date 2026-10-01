import prisma from "@rw/db";
import { complete as completeCycle } from "@rw/services/cycle/cycle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkcenterBucket, makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const ADMIN_EMAIL = "pace-admin@test.local";
const PASSWORD = "pace-test-password-1";
const P = "pace-test";

// Tier 2: slow and fast detection — a station's own detects, its workcenter's
// defaults, the pace stamped on each cycle and the status that follows it.
describe.skipIf(!process.env.TEST_DATABASE_URL)("pace detection", () => {
  let server: TestServer;
  let siteId: string;
  let workcenterId: string;
  let admin: string;
  let jobId: string;
  const stationIds: string[] = [];

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    const site = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    siteId = site.id;
    const workcenter = await prisma.workcenter.create({ data: { name: `${P}-wc`, siteId }, select: { id: true } });
    workcenterId = workcenter.id;
    await ensureWorkcenterBucket(site.workspaceId, siteId, workcenterId, `${P}-wc`);
    await makeUser(ADMIN_EMAIL, PASSWORD, { plants: [{ siteId, level: "ADMIN" }] });
    admin = (await loginAs(server, ADMIN_EMAIL, PASSWORD)).accessToken;
    // A 30-second job: with 25% slow and 20% fast, slow is over 37.5 s and fast is under 24 s.
    jobId = (await call<{ id: string }>("job/create", { siteId, name: `${P}-job`, standardCycle: 30 })).id;
  }, 30_000);

  afterAll(async () => {
    await prisma.inventoryItem.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.cycle.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.stationStateLog.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.stationJobLog.deleteMany({ where: { stationId: { in: stationIds } } });
    await prisma.station.deleteMany({ where: { id: { in: stationIds } } });
    await prisma.job.updateMany({ where: { id: jobId }, data: { currentVersionId: null } });
    await prisma.jobVersion.deleteMany({ where: { jobId } });
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.workcenter.deleteMany({ where: { id: workcenterId } });
    await prisma.user.deleteMany({ where: { email: ADMIN_EMAIL } });
    await server.close();
  });

  async function call<T>(path: string, input: unknown, status = 200): Promise<T> {
    const res = await rpcCall(server, path, input, admin);
    expect(res.statusCode, `${path} → ${JSON.stringify(res.json)}`).toBe(status);
    return res.json as T;
  }
  async function station(name: string, input: Record<string, unknown> = {}) {
    const made = await call<{ id: string }>("station/create", {
      siteId,
      workcenterId,
      name: `${P}-${name}`,
      ...input,
    });
    stationIds.push(made.id);
    return made.id;
  }

  /**
   * Record cycles `gaps` seconds apart (the first is the station's opening
   * cycle) and return each one's pace and the status the station held after it.
   */
  async function run(stationId: string, gaps: number[]) {
    let at = Date.now() - 3_600_000;
    const outcomes: Array<{ pace: string | null; status: string | null }> = [];
    for (const gap of [0, ...gaps]) {
      at += gap * 1000;
      const result = await completeCycle({ stationId, timestamp: new Date(at), jobId });
      if ("error" in result && result.error) throw new Error(String(result.error));
      const cycle = await prisma.cycle.findUniqueOrThrow({
        where: { id: (result as { data: { id: string } }).data.id },
        select: { pace: true },
      });
      const open = await prisma.stationStateLog.findFirst({
        where: { stationId, endTime: null, deletedAt: null },
        select: { state: true, status: true },
      });
      outcomes.push({ pace: cycle.pace, status: open ? (open.status ?? open.state) : null });
    }
    return outcomes;
  }

  it("a workcenter holds the defaults; validation keeps a fast detect under 100%", async () => {
    const updated = await call<Record<string, unknown>>("workcenter/update", {
      id: workcenterId,
      slowDetect: 0.25,
      fastDetect: 0.2,
      downtimeDetect: 60,
    });
    expect(Number(updated.slowDetect)).toBe(0.25);
    expect(Number(updated.fastDetect)).toBe(0.2);
    expect(Number(updated.downtimeDetect)).toBe(60);
    const read = await call<Record<string, unknown>>("workcenter/get", { id: workcenterId });
    expect(Number(read.fastDetect)).toBe(0.2);

    // 100% faster could never be met; a station may say 0 (off) but a default may not.
    await call("workcenter/update", { id: workcenterId, fastDetect: 1 }, 400);
    await call("workcenter/update", { id: workcenterId, slowDetect: 0 }, 400);
    await call("station/create", { siteId, workcenterId, name: `${P}-bad`, fastDetect: 1 }, 400);
  });

  it("a station with no detects of its own uses its workcenter's, for slow and for fast", async () => {
    const id = await station("inherits");
    //                              on pace  fast  fast  on pace  slow  fast
    const outcomes = await run(id, [30, 20, 21, 30, 40, 10]);
    expect(outcomes.map((each) => each.pace)).toEqual([null, "NORMAL", "FAST", "FAST", "NORMAL", "SLOW", "FAST"]);
    // The status is how the last completed cycle ran, and holds until one runs differently.
    expect(outcomes.map((each) => each.status)).toEqual(["UP", "UP", "FAST", "FAST", "UP", "SLOW", "FAST"]);
  });

  it("the edges are not slow or fast: only beyond the detect", async () => {
    const id = await station("edges");
    // Exactly 37.5 s and exactly 24 s are still on pace.
    const outcomes = await run(id, [37.5, 24, 37.6, 23.9]);
    expect(outcomes.map((each) => each.pace)).toEqual([null, "NORMAL", "NORMAL", "SLOW", "FAST"]);
  });

  it("a station's own detect overrides the workcenter's, and 0 turns one off", async () => {
    // Fast only at 50% (under 15 s); slow off whatever the workcenter says.
    const id = await station("overrides", { fastDetect: 0.5, slowDetect: 0 });
    const made = await call<{ currentVersion: Record<string, unknown> }>("station/get", { id });
    expect(Number(made.currentVersion.fastDetect)).toBe(0.5);
    expect(Number(made.currentVersion.slowDetect)).toBe(0);

    const outcomes = await run(id, [20, 100, 14]);
    expect(outcomes.map((each) => each.pace)).toEqual([null, "NORMAL", "NORMAL", "FAST"]);
    expect(outcomes.map((each) => each.status)).toEqual(["UP", "UP", "UP", "FAST"]);

    // Clearing the override (null) goes back to the workcenter's 20%.
    await call("station/update", { id, fastDetect: null, slowDetect: null });
    const at = new Date();
    const last = await prisma.cycle.findFirstOrThrow({
      where: { stationId: id },
      orderBy: { end: "desc" },
      select: { end: true },
    });
    const gapSeconds = 20;
    const next = await completeCycle({
      stationId: id,
      timestamp: new Date(Math.min(at.getTime(), last.end!.getTime() + gapSeconds * 1000)),
      jobId,
    });
    if ("error" in next && next.error) throw new Error(String(next.error));
    const cycle = await prisma.cycle.findUniqueOrThrow({
      where: { id: (next as { data: { id: string } }).data.id },
      select: { pace: true },
    });
    expect(cycle.pace).toBe("FAST");
  });

  it("with no detect anywhere a cycle is judged on pace, and no standard is not judged", async () => {
    await call("workcenter/update", { id: workcenterId, slowDetect: null, fastDetect: null, downtimeDetect: null });
    const id = await station("none");
    const outcomes = await run(id, [5, 300]);
    expect(outcomes.map((each) => each.pace)).toEqual([null, "NORMAL", "NORMAL"]);
    expect(outcomes.map((each) => each.status)).toEqual(["UP", "UP", "UP"]);
    await call("workcenter/update", { id: workcenterId, slowDetect: 0.25, fastDetect: 0.2 });
  });

  it("the cycle log and the Cycles report carry each cycle's pace", async () => {
    const id = stationIds[0]!;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const log = await call<{ data: Array<{ pace: string | null }> }>("logs/cycleSearch", {
      siteId,
      stationId: id,
      startDate: yesterday,
      endDate: today,
      limit: 0,
    });
    const paces = log.data.map((row) => row.pace);
    expect(paces.filter((pace) => pace === "FAST")).toHaveLength(3);
    expect(paces.filter((pace) => pace === "SLOW")).toHaveLength(1);

    const report = await call<{ rows: Array<Record<string, unknown>> }>("report/query", {
      siteId,
      fact: "cycles",
      measures: ["cycles", "slowCycles", "fastCycles"],
      dimensions: ["pace"],
      dateFrom: yesterday,
      dateTo: today,
      filters: [{ dimension: "station", op: "eq", value: id }],
    });
    const byPace = Object.fromEntries(report.rows.map((row) => [String(row.pace), Number(row.cycles)]));
    expect(byPace.FAST).toBe(3);
    expect(byPace.SLOW).toBe(1);
    expect(byPace.NORMAL).toBe(2);
    const totals = report.rows.reduce<{ slow: number; fast: number }>(
      (sum, row) => ({ slow: sum.slow + Number(row.slowCycles), fast: sum.fast + Number(row.fastCycles) }),
      { slow: 0, fast: 0 },
    );
    expect(totals).toEqual({ slow: 1, fast: 3 });
  });
});
