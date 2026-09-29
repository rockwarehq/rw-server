import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma, { ensureAccountWorkspace } from "@rw/db";
import { getCurrentShift } from "./current.js";

// Integration tests for the current business date. Require DATABASE_URL.

describe.skipIf(!process.env.DATABASE_URL)("current business date", () => {
  let workspaceId: string;

  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000);
  const DAY = 86_400_000;
  const today = new Date(Math.floor(Date.now() / DAY) * DAY);
  const tomorrow = new Date(today.getTime() + DAY);
  const iso = (date: Date) => date.toISOString().slice(0, 10);

  beforeAll(async () => {
    workspaceId = (await ensureAccountWorkspace({ name: "Test Account", slug: "test-account" })).id;
  });

  /** A UTC site with one workcenter per entry, each on a shift covering now. */
  async function site(running: { businessDate: Date; isScheduled: boolean }[]) {
    const suffix = randomUUID();
    const siteId = (await prisma.site.create({ data: { name: `Current ${suffix}`, workspaceId } })).id;
    const workcenterIds: string[] = [];
    for (const [i, shift] of running.entries()) {
      const workCenterId = (await prisma.workcenter.create({ data: { name: `WC${i} ${suffix}`, siteId } })).id;
      const pattern = await prisma.shiftPattern.create({ data: { siteId, name: `P${i}` } });
      const assignment = await prisma.shiftAssignment.create({
        data: { patternId: pattern.id, siteId, workCenterId, rotationStartDate: at(-48) },
      });
      await prisma.shiftInstance.create({
        data: {
          assignmentId: assignment.id,
          siteId,
          workCenterId,
          shiftName: shift.isScheduled ? "Night" : "Not Scheduled",
          isScheduled: shift.isScheduled,
          businessDate: shift.businessDate,
          startTime: at(-2),
          endTime: at(2),
        },
      });
      workcenterIds.push(workCenterId);
    }
    return { siteId, workcenterIds };
  }

  async function businessDate(siteId: string, workCenterId?: string) {
    const result = await getCurrentShift(siteId, workCenterId);
    if (!("data" in result)) throw new Error(result.error);
    return result.data.businessDate;
  }

  test("a site with no shift running falls back to its calendar date", async () => {
    const { siteId } = await site([]);
    expect(await businessDate(siteId)).toBe(iso(today));
  });

  test("the site takes the business date its workcenters are on, not the clock's", async () => {
    const { siteId } = await site([{ businessDate: tomorrow, isScheduled: true }]);
    expect(await businessDate(siteId)).toBe(iso(tomorrow));
  });

  test("when lines disagree, the latest business date is the one underway", async () => {
    const { siteId } = await site([
      { businessDate: today, isScheduled: true },
      { businessDate: tomorrow, isScheduled: true },
    ]);
    expect(await businessDate(siteId)).toBe(iso(tomorrow));
  });

  test("a worked shift outranks a Not Scheduled gap", async () => {
    const { siteId } = await site([
      { businessDate: today, isScheduled: true },
      { businessDate: tomorrow, isScheduled: false },
    ]);
    expect(await businessDate(siteId)).toBe(iso(today));
  });

  test("a workcenter gets its own business date", async () => {
    const { siteId, workcenterIds } = await site([
      { businessDate: today, isScheduled: true },
      { businessDate: tomorrow, isScheduled: true },
    ]);
    expect(await businessDate(siteId, workcenterIds[0])).toBe(iso(today));
  });
});
