import { describe, expect, it } from "vitest";
import { localTime, nextDailyRun, scheduleMatches } from "./daily.js";

const CHICAGO = "America/Chicago";
const at = (iso: string) => new Date(iso);

describe("nextDailyRun", () => {
  it("fires later today when the time has not passed", () => {
    // 2026-09-28 is a Monday; 10:00 CDT = 15:00Z.
    expect(nextDailyRun({ time: "23:00", days: [] }, CHICAGO, at("2026-09-28T15:00:00Z"))).toEqual(
      at("2026-09-29T04:00:00Z"),
    );
  });

  it("rolls to tomorrow once the time has passed, and never returns `after` itself", () => {
    const due = at("2026-09-29T04:00:00Z");
    expect(nextDailyRun({ time: "23:00", days: [] }, CHICAGO, due)).toEqual(at("2026-09-30T04:00:00Z"));
  });

  it("skips to the next allowed day", () => {
    // Monday 23:00 has passed → next Monday.
    expect(nextDailyRun({ time: "23:00", days: [1] }, CHICAGO, at("2026-09-29T05:00:00Z"))).toEqual(
      at("2026-10-06T04:00:00Z"),
    );
  });

  it("keeps the wall-clock time across a DST change", () => {
    // Clocks fall back 2026-11-01: 23:00 CST = 05:00Z the next day.
    expect(nextDailyRun({ time: "23:00", days: [] }, CHICAGO, at("2026-11-01T12:00:00Z"))).toEqual(
      at("2026-11-02T05:00:00Z"),
    );
  });

  it("uses the site's local date, not UTC's", () => {
    // 2026-09-29T02:00Z is still Monday 21:00 in Chicago.
    expect(nextDailyRun({ time: "23:00", days: [1] }, CHICAGO, at("2026-09-29T02:00:00Z"))).toEqual(
      at("2026-09-29T04:00:00Z"),
    );
  });
});

describe("localTime / scheduleMatches", () => {
  it("reads the wall clock in the timezone", () => {
    expect(localTime(at("2026-09-29T04:00:00Z"), CHICAGO)).toEqual({ date: "2026-09-28", time: "23:00", dayOfWeek: 1 });
  });

  it("matches on time and allowed days", () => {
    const monday = { date: "2026-09-28", time: "23:00", dayOfWeek: 1 };
    expect(scheduleMatches({ time: "23:00", days: [] }, monday)).toBe(true);
    expect(scheduleMatches({ time: "23:00", days: [1, 3] }, monday)).toBe(true);
    expect(scheduleMatches({ time: "23:00", days: [2] }, monday)).toBe(false);
    expect(scheduleMatches({ time: "07:00", days: [] }, monday)).toBe(false);
  });
});
