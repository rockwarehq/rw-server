import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import { splitOpenPeriodsForAllStations } from "./periods.js";
import { transitionToDown } from "./state.js";

// Integration test: requires DATABASE_URL. Two back-to-back shifts A and B;
// the station's open state row and job log started in A and now is in B.

const hour = 60 * 60 * 1000;

describe.skipIf(!process.env.DATABASE_URL)("shift period splits", () => {
  let siteId: string;
  let stationId: string;
  let jobId: string;
  let shiftA: string;
  let shiftB: string;
  const now = new Date();
  const boundary = new Date(now.getTime() - 1 * hour);
  const at = (h: number) => new Date(boundary.getTime() + h * hour);

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({ data: { name: `Split ${suffix}`, slug: `split-${suffix}` } });
    siteId = (await prisma.site.create({ data: { name: `Split Site ${suffix}`, workspaceId: workspace.id } })).id;
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

    const job = await prisma.job.create({ data: { siteId } });
    const jv = await prisma.jobVersion.create({ data: { jobId: job.id, version: 1, name: "J" } });
    await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: jv.id } });
    jobId = job.id;
    stationId = (await prisma.station.create({ data: { siteId, name: "Press", currentJobId: jobId } })).id;

    await prisma.stationJobLog.create({
      data: {
        stationId,
        siteId,
        blockId: "run-1",
        jobId,
        jobVersionId: jv.id,
        startTime: at(-3),
        shiftInstanceId: shiftA,
      },
    });
    await prisma.stationStateLog.create({
      data: {
        stationId,
        siteId,
        blockId: "up-1",
        startTime: at(-3),
        state: "UP",
        status: "UP",
        shiftInstanceId: shiftA,
      },
    });
    await prisma.cycle.create({
      data: { siteId, stationId, jobId, jobVersionId: jv.id, start: at(-0.6), end: at(-0.5), cycleStatus: "GOOD" },
    });
  });

  test("the sweep cuts open rows at the boundary and continues them under the same block", async () => {
    expect(await splitOpenPeriodsForAllStations(now)).toBeGreaterThanOrEqual(1);
    const jobs = await prisma.stationJobLog.findMany({ where: { stationId }, orderBy: { startTime: "asc" } });
    expect(jobs.map((r) => [r.blockId, r.shiftInstanceId, r.endTime?.getTime() ?? null])).toEqual([
      ["run-1", shiftA, boundary.getTime()],
      ["run-1", shiftB, null],
    ]);
    const states = await prisma.stationStateLog.findMany({ where: { stationId }, orderBy: { startTime: "asc" } });
    expect(states.map((r) => [r.blockId, r.status, r.shiftInstanceId, r.endTime?.getTime() ?? null])).toEqual([
      ["up-1", "UP", shiftA, boundary.getTime()],
      ["up-1", "UP", shiftB, null],
    ]);
    // Idempotent: nothing left to cut.
    expect(await splitOpenPeriodsForAllStations(now)).toBe(0);
  });

  test("a backdated DOWN reaches into the previous shift's piece under one new block", async () => {
    await transitionToDown(stationId, now);
    const states = await prisma.stationStateLog.findMany({
      where: { stationId, deletedAt: null },
      orderBy: { startTime: "asc" },
    });
    expect(
      states.map((r) => [r.status, r.shiftInstanceId, r.startTime.getTime(), r.endTime?.getTime() ?? null]),
    ).toEqual([
      ["UP", shiftA, at(-3).getTime(), at(-0.5).getTime()],
      ["DOWN", shiftA, at(-0.5).getTime(), boundary.getTime()],
      ["DOWN", shiftB, boundary.getTime(), null],
    ]);
    const downBlocks = new Set(states.filter((r) => r.status === "DOWN").map((r) => r.blockId));
    expect(downBlocks.size).toBe(1);
    expect(downBlocks.has("up-1")).toBe(false);
  });
});
