import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import { getSiteTimezone } from "../../metrics/bucket.js";
import { rematerializeSite } from "../shift/materialize.js";
import * as sites from "./crud.js";

// Integration tests (shift-signoff.test.ts conventions): require DATABASE_URL.
// A site timezone change is a schedule edit (ADR-0015): upcoming shifts and
// overrides keep their local clock times in the new zone, while history and
// shifts already in use stay where they are.

const HOUR = 3_600_000;

/** "HH:mm" of an instant on a zone's clock. */
const clock = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

describe.skipIf(!process.env.DATABASE_URL)("site timezone change", () => {
  let siteId: string;
  let assignmentId: string;
  let pastIds: string[];
  let noted: { id: string; startTime: Date };
  let overrideId: string;

  const scheduled = () =>
    prisma.shiftInstance.findMany({
      where: { assignmentId, isScheduled: true },
      orderBy: { startTime: "asc" },
    });

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.findFirstOrThrow();
    siteId = (
      await prisma.site.create({
        data: { name: `TZ Site ${suffix}`, workspaceId: workspace.id, timezone: "America/New_York" },
      })
    ).id;
    const workcenterId = (await prisma.workcenter.create({ data: { name: `WC ${suffix}`, siteId } })).id;

    // One 18:00 shift every day.
    const pattern = await prisma.shiftPattern.create({ data: { siteId, name: "P", totalDaysInRotation: 1 } });
    await prisma.shiftDefinition.create({
      data: {
        patternId: pattern.id,
        dayOfRotation: 1,
        sortOrder: 1,
        startTime: "18:00",
        durationHrs: 6,
        shiftName: "S",
      },
    });
    const today = new Date(Math.floor(Date.now() / (24 * HOUR)) * 24 * HOUR);
    assignmentId = (
      await prisma.shiftAssignment.create({
        data: { patternId: pattern.id, siteId, rotationStartDate: new Date(today.getTime() - 3 * 24 * HOUR) },
      })
    ).id;
    await rematerializeSite(siteId);

    const rows = await scheduled();
    pastIds = rows.filter((r) => r.endTime.getTime() < Date.now()).map((r) => r.id);
    // A note on an upcoming shift keeps it in use, though nothing is stamped on it.
    const upcoming = rows.filter((r) => r.startTime.getTime() > Date.now());
    noted = upcoming[0];
    await prisma.shiftComment.create({
      data: { siteId, shiftInstanceId: noted.id, workcenterId, text: "Hopper ran low" },
    });

    // 20:00-02:00 New York on a later day.
    const later = upcoming[3];
    overrideId = (
      await prisma.shiftOverride.create({
        data: {
          siteId,
          businessDate: later.businessDate,
          shiftName: "S",
          startTime: new Date(later.startTime.getTime() + 2 * HOUR),
          endTime: new Date(later.endTime.getTime() + 2 * HOUR),
        },
      })
    ).id;
    // Warm the cache, so the update has to forget it.
    expect(await getSiteTimezone(siteId)).toBe("America/New_York");
  });

  test("saving the same zone changes nothing", async () => {
    const before = (await scheduled()).map((r) => r.id);
    const result = await sites.update(siteId, { timezone: "America/New_York" });
    if ("error" in result) throw new Error(result.error);
    expect((await scheduled()).map((r) => r.id)).toEqual(before);
  });

  test("upcoming shifts and overrides keep their clock times; history and noted shifts stay", async () => {
    const result = await sites.update(siteId, { timezone: "America/Chicago" });
    if ("error" in result) throw new Error(result.error);
    expect(await getSiteTimezone(siteId)).toBe("America/Chicago");

    const rows = await scheduled();
    const ids = new Set(rows.map((r) => r.id));
    for (const id of pastIds) expect(ids.has(id)).toBe(true);

    // The noted shift is untouched, still 18:00 New York, and its note is there.
    const kept = rows.find((r) => r.id === noted.id);
    expect(kept?.startTime).toEqual(noted.startTime);
    expect(await prisma.shiftComment.count({ where: { shiftInstanceId: noted.id } })).toBe(1);

    const override = await prisma.shiftOverride.findUniqueOrThrow({ where: { id: overrideId } });
    if (!override.startTime) throw new Error("override lost its window");
    expect(clock(override.startTime, "America/Chicago")).toBe("20:00");

    // Every other upcoming shift starts on the Chicago clock: 18:00, or 20:00 on the overridden day.
    const rebuilt = rows.filter((r) => r.startTime > noted.startTime && r.id !== noted.id);
    expect(rebuilt.length).toBeGreaterThan(0);
    for (const r of rebuilt) {
      const expected = r.startTime.getTime() === override.startTime.getTime() ? "20:00" : "18:00";
      expect(clock(r.startTime, "America/Chicago")).toBe(expected);
    }
  });
});
