import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma, { ensureAccountWorkspace } from "@rw/db";
import { amendJobHistory } from "../../history/amend-job.js";
import { applyCurrentStandardsToOpenJobLog } from "./job-log-standards.js";
import { splitOpenPeriodsAtShiftBoundaries } from "./periods.js";
import { acquireStationLock } from "./state.js";

// Integration test: requires DATABASE_URL. A 100 ft-per-cycle extruder runs a
// job whose rate was corrected from 35 to 300 ft/min after the run started, so
// the open job log still carries the 35 ft/min standard (171.43 s per 100 ft).

const hour = 60 * 60 * 1000;

describe.skipIf(!process.env.DATABASE_URL)("job logs take the job's current standard", () => {
  let siteId: string;
  let stationId: string;
  let jobId: string;
  let v1: string;
  let shiftA: string;
  let shiftB: string;
  const now = new Date();
  const boundary = new Date(now.getTime() - 1 * hour);
  const at = (h: number) => new Date(boundary.getTime() + h * hour);

  const jobVersion = (version: number, standardRate: number) =>
    prisma.jobVersion.create({
      data: { jobId, version, name: "EXT-JOB", standardRate, standardRateUnit: "ft", standardRatePeriod: "MINUTE" },
    });
  const makeCurrent = (versionId: string) =>
    prisma.job.update({ where: { id: jobId }, data: { currentVersionId: versionId } });
  const cycle = (end: Date, quantity: number) =>
    prisma.cycle.create({
      data: {
        siteId,
        stationId,
        jobId,
        jobVersionId: v1,
        start: new Date(end.getTime() - 20_000),
        end,
        cycleStatus: "GOOD",
        quantity,
        quantityUnit: "ft",
        standardCycle: (quantity * 60) / 35,
        standardQuantity: 100,
      },
    });
  const standardOf = async (id: string) => {
    const c = await prisma.cycle.findUniqueOrThrow({ where: { id } });
    return [c.jobVersionId, c.standardCycle?.toNumber() ?? null];
  };

  let cycleInA: string;
  let cycleInB: string;
  let cycleToAmend: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await ensureAccountWorkspace({ name: "Test Account", slug: "test-account" });
    siteId = (await prisma.site.create({ data: { name: `Standards Site ${suffix}`, workspaceId: workspace.id } })).id;
    const pattern = await prisma.shiftPattern.create({ data: { siteId, name: "P" } });
    const definition = await prisma.shiftDefinition.create({
      data: {
        patternId: pattern.id,
        dayOfRotation: 1,
        sortOrder: 1,
        startTime: "06:00",
        durationHrs: 8,
        shiftName: "S",
      },
    });
    const assignment = await prisma.shiftAssignment.create({
      data: { patternId: pattern.id, siteId, rotationStartDate: at(-48) },
    });
    const shift = (name: string, start: Date, end: Date) =>
      prisma.shiftInstance.create({
        data: {
          assignmentId: assignment.id,
          definitionId: definition.id,
          siteId,
          shiftName: name,
          businessDate: start,
          startTime: start,
          endTime: end,
        },
      });
    shiftA = (await shift("A", at(-8), boundary)).id;
    shiftB = (await shift("B", boundary, at(8))).id;

    jobId = (await prisma.job.create({ data: { siteId } })).id;
    v1 = (await jobVersion(1, 35)).id;
    await makeCurrent(v1);

    stationId = (await prisma.station.create({ data: { siteId, name: "EXT", currentJobId: jobId } })).id;
    const sv = await prisma.stationVersion.create({
      data: {
        stationId,
        version: 1,
        cycleMode: "QUANTITY_PER_CYCLE",
        standardQuantity: 100,
        quantityUnit: "ft",
        standardRate: 300,
        standardRateUnit: "ft",
        standardRatePeriod: "MINUTE",
      },
    });
    await prisma.station.update({ where: { id: stationId }, data: { currentVersionId: sv.id } });

    await prisma.stationJobLog.create({
      data: {
        stationId,
        siteId,
        blockId: "run-1",
        jobId,
        jobVersionId: v1,
        startTime: at(-3),
        shiftInstanceId: shiftA,
        standardCycle: 171.43,
        standardQuantity: 100,
        quantityUnit: "ft",
      },
    });
    cycleToAmend = (await cycle(at(-1.5), 50)).id;
    cycleInA = (await cycle(at(-0.5), 100)).id;
    cycleInB = (await cycle(at(0.5), 100)).id;

    // The correction lands mid-run.
    await makeCurrent((await jobVersion(2, 300)).id);
  });

  test("a new shift's job log reads the job, not the previous shift's snapshot", async () => {
    // This station only: the site-wide sweep would race periods.test.ts's.
    await prisma.$transaction(async (tx) => {
      await acquireStationLock(tx, stationId);
      await splitOpenPeriodsAtShiftBoundaries(tx, { id: stationId, siteId, workcenterId: null }, now);
    });
    const v2 = (await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).currentVersionId;
    const logs = await prisma.stationJobLog.findMany({ where: { stationId }, orderBy: { startTime: "asc" } });
    expect(
      logs.map((r) => [r.blockId, r.shiftInstanceId, r.jobVersionId, r.standardCycle?.toNumber() ?? null]),
    ).toEqual([
      ["run-1", shiftA, v1, 171.43],
      // 100 ft at 300 ft/min.
      ["run-1", shiftB, v2, 20],
    ]);
  });

  test("editing the running job's standard restates the open log and its cycles, not earlier shifts", async () => {
    const v3 = (await jobVersion(3, 150)).id;
    await makeCurrent(v3);

    expect(await applyCurrentStandardsToOpenJobLog(stationId, jobId, now)).toEqual({ start: boundary, end: now });
    const open = await prisma.stationJobLog.findFirstOrThrow({ where: { stationId, endTime: null } });
    expect([open.jobVersionId, open.standardCycle?.toNumber()]).toEqual([v3, 40]);
    // 100 ft at 150 ft/min.
    expect(await standardOf(cycleInB)).toEqual([v3, 40]);
    // The previous shift keeps its snapshot.
    expect(await standardOf(cycleInA)).toEqual([v1, 171.43]);

    // Already current: nothing to do.
    expect(await applyCurrentStandardsToOpenJobLog(stationId, jobId, now)).toBeNull();
  });

  test("an amendment grades the window on the job's current standard, per cycle quantity", async () => {
    const current = (await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).currentVersionId;
    const result = await amendJobHistory({ stationId, jobId, from: at(-2), to: at(-1) });
    if ("error" in result) throw new Error(result.error);

    const amended = await prisma.stationJobLog.findFirstOrThrow({
      where: { stationId, startTime: at(-2) },
    });
    expect([amended.jobVersionId, amended.standardCycle?.toNumber()]).toEqual([current, 40]);
    // 50 ft at 150 ft/min earns 20 s, not the flat 100 ft standard.
    expect(await standardOf(cycleToAmend)).toEqual([current, 20]);
  });
});
