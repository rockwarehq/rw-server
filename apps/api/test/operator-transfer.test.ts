import { afterAll, beforeAll, describe, expect, it } from "vitest";
import prisma from "@rw/db";
import { logoff, logoffAll, transferSessions } from "../src/services/employee/logon.js";

// Tier 2: needs a migrated + seeded Postgres (TEST_DATABASE_URL).
describe.skipIf(!process.env.TEST_DATABASE_URL)("operator session transfer (Tier 2)", () => {
  let siteId: string;
  let stationA: { id: string };
  let stationB: { id: string };
  let display: { id: string };
  let otherDisplay: { id: string };

  beforeAll(async () => {
    const rockware = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } });
    siteId = rockware.id;
    const station = (name: string) =>
      prisma.station.upsert({
        where: { siteId_name: { siteId, name } },
        update: {},
        create: { name, siteId },
        select: { id: true },
      });
    stationA = await station("xfer-st-a");
    stationB = await station("xfer-st-b");
    display = await prisma.display.create({
      data: { name: "xfer-display", status: "CLAIMED", siteId },
      select: { id: true },
    });
    otherDisplay = await prisma.display.create({
      data: { name: "xfer-display-other", status: "CLAIMED", siteId },
      select: { id: true },
    });
  });

  afterAll(async () => {
    await prisma.stationLogonSession.deleteMany({ where: { displayId: { in: [display.id, otherDisplay.id] } } });
    await prisma.display.deleteMany({ where: { id: { in: [display.id, otherDisplay.id] } } });
    await prisma.station.deleteMany({ where: { id: { in: [stationA.id, stationB.id] } } });
  });

  it("ends each session at the old station and opens it, for the same operator, at the new one", async () => {
    const open = (displayId: string, genericName: string) =>
      prisma.stationLogonSession.create({
        data: { displayId, stationId: stationA.id, siteId, logonMethod: "GENERIC", genericName },
        select: { id: true },
      });
    const [first, second] = [await open(display.id, "Dana"), await open(display.id, "Lee")];
    // Someone on the same station from another display is not this display's to move.
    const theirs = await open(otherDisplay.id, "Sam");

    const result = await transferSessions(display.id, stationB.id);
    expect(result).toEqual({ data: { count: 2 } });

    const ended = await prisma.stationLogonSession.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { logoffTime: true },
    });
    expect(ended.every((session) => session.logoffTime !== null)).toBe(true);

    const moved = await prisma.stationLogonSession.findMany({
      where: { displayId: display.id, logoffTime: null },
      select: { stationId: true, genericName: true, logonMethod: true, logonTime: true },
      orderBy: { genericName: "asc" },
    });
    expect(moved.map((session) => [session.stationId, session.genericName, session.logonMethod])).toEqual([
      [stationB.id, "Dana", "GENERIC"],
      [stationB.id, "Lee", "GENERIC"],
    ]);
    // No gap: each new session starts the instant the old one ended.
    expect(moved[0].logonTime.getTime()).toBe(ended[0].logoffTime!.getTime());

    const untouched = await prisma.stationLogonSession.findUniqueOrThrow({
      where: { id: theirs.id },
      select: { stationId: true, logoffTime: true },
    });
    expect(untouched).toEqual({ stationId: stationA.id, logoffTime: null });
  });

  it("leaves sessions already at the new station alone", async () => {
    const before = await prisma.stationLogonSession.count({ where: { displayId: display.id } });
    expect(await transferSessions(display.id, stationB.id)).toEqual({ data: { count: 0 } });
    expect(await prisma.stationLogonSession.count({ where: { displayId: display.id } })).toBe(before);
  });

  it("refuses a station that does not exist", async () => {
    const result = await transferSessions(display.id, "00000000-0000-4000-8000-000000000000");
    expect(result).toEqual({ error: "Station not found", code: "STATION_NOT_FOUND" });
  });

  it("logging everyone off records each session it ended", async () => {
    const open = (genericName: string) =>
      prisma.stationLogonSession.create({
        data: { displayId: otherDisplay.id, stationId: stationA.id, siteId, logonMethod: "GENERIC", genericName },
        select: { id: true },
      });
    const sessions = [await open("Kim"), await open("Ray")];

    const result = await logoffAll(otherDisplay.id);
    expect(result.data.count).toBeGreaterThanOrEqual(2);

    const entries = await prisma.auditLog.findMany({
      where: { action: "OPERATOR_LOGOFF", metadata: { path: ["displayId"], equals: otherDisplay.id } },
      select: { metadata: true },
    });
    const ended = entries.map((entry) => (entry.metadata as { sessionId?: string }).sessionId);
    for (const session of sessions) expect(ended).toContain(session.id);
    expect(entries.every((entry) => (entry.metadata as { allSessions?: boolean }).allSessions)).toBe(true);
  });

  it("records one log-off when an operator and a bulk log-off end the same session at once", async () => {
    const session = await prisma.stationLogonSession.create({
      data: { displayId: otherDisplay.id, stationId: stationB.id, siteId, logonMethod: "GENERIC", genericName: "Lee" },
      select: { id: true },
    });
    await Promise.all([logoff(session.id, otherDisplay.id), logoffAll(otherDisplay.id)]);
    const entries = await prisma.auditLog.count({
      where: { action: "OPERATOR_LOGOFF", metadata: { path: ["sessionId"], equals: session.id } },
    });
    expect(entries).toBe(1);
  });
});
