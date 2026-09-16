import { describe, expect, it } from "vitest";
import { computeBusinessDate } from "./materialize.js";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ms = (s: string) => new Date(s).getTime();

describe("computeBusinessDate", () => {
  // Dixie shape: 3 shifts 08:30 -> 08:30 (+1), east-of-UTC site, first-start mode.
  // The fix must not change these stamps (previously computed from the anchor,
  // which shares the local date with the first start when the offset >= 0).
  it("east-of-UTC first-start mode: unchanged (anchor date == first-start date)", () => {
    const starts = [ms("2026-08-20T08:30:00Z"), ms("2026-08-20T17:00:00Z"), ms("2026-08-21T00:45:00Z")];
    const ends = [ms("2026-08-20T17:00:00Z"), ms("2026-08-21T00:45:00Z"), ms("2026-08-21T08:30:00Z")];
    expect(iso(computeBusinessDate(starts, ends, false, "Africa/Nairobi"))).toBe("2026-08-20");
    expect(iso(computeBusinessDate(starts, ends, false, "UTC"))).toBe("2026-08-20");
  });

  // Trimlok shape: Shift 1 05:00-15:30, Shift 2 15:30-01:30 (+1) Elkhart time,
  // stored UTC. Business date must be the first shift's LOCAL start day.
  it("west-of-UTC first-start mode: stamps the first shift's local start day", () => {
    const starts = [ms("2026-08-20T09:00:00Z"), ms("2026-08-20T19:30:00Z")];
    const ends = [ms("2026-08-20T19:30:00Z"), ms("2026-08-21T05:30:00Z")];
    expect(iso(computeBusinessDate(starts, ends, false, "America/Indiana/Indianapolis"))).toBe("2026-08-20");
  });

  // Sim shape: last-end mode is untouched by the fix.
  it("last-end mode: unchanged, stamps the last shift's local end day", () => {
    const starts = [ms("2026-08-27T01:00:00Z"), ms("2026-08-27T09:00:00Z"), ms("2026-08-27T17:00:00Z")];
    const ends = [ms("2026-08-27T09:00:00Z"), ms("2026-08-27T17:00:00Z"), ms("2026-08-28T01:00:00Z")];
    expect(iso(computeBusinessDate(starts, ends, true, "America/New_York"))).toBe("2026-08-27");
  });

  it("first shift starting before local midnight stamps the prior local day", () => {
    // Block starting 23:00 local (03:00Z next UTC day) belongs to the local day it starts.
    const starts = [ms("2026-08-21T03:00:00Z")];
    const ends = [ms("2026-08-21T11:00:00Z")];
    expect(iso(computeBusinessDate(starts, ends, false, "America/New_York"))).toBe("2026-08-20");
  });
});

// ── Gap filling and overrides ────────────────────────────────────

import {
  type AssignmentWithPattern,
  buildInstanceRows,
  hasOverlappingRows,
  type InstanceRow,
  OFF_HOURS_NAME,
} from "./materialize.js";

const day = (s: string) => new Date(`${s}T00:00:00Z`);

// Three 6h shifts per rotation day starting 06:00Z; weekday-only 7-day rotation.
const assignment: AssignmentWithPattern = {
  id: "asg",
  siteId: "site",
  workCenterId: null,
  rotationStartDate: day("2026-09-14"), // Monday
  rotationEndDate: null,
  rotationStartDefinition: null,
  pattern: {
    totalDaysInRotation: 7,
    useEndDateForBusinessDate: false,
    shifts: [1, 2, 3, 4, 5].flatMap((d) => [
      {
        id: `d${d}s1`,
        dayOfRotation: d,
        sortOrder: 1,
        startDayOffset: 0,
        startTime: "06:00",
        durationHrs: 6,
        shiftName: "Shift 1",
        isScheduled: true,
      },
      {
        id: `d${d}s2`,
        dayOfRotation: d,
        sortOrder: 2,
        startDayOffset: 0,
        startTime: "14:00",
        durationHrs: 6,
        shiftName: "Shift 2",
        isScheduled: true,
      },
      {
        id: `d${d}s3`,
        dayOfRotation: d,
        sortOrder: 3,
        startDayOffset: 0,
        startTime: "22:00",
        durationHrs: 6,
        shiftName: "Shift 3",
        isScheduled: true,
      },
    ]),
  },
};

const brief = (r: InstanceRow) =>
  `${r.shiftName}|${iso(r.businessDate)}|${r.startTime.toISOString().slice(5, 16)}→${r.endTime.toISOString().slice(5, 16)}|${r.isScheduled ? "S" : "N"}`;

describe("fillNotScheduledGaps", () => {
  it("fills gaps between shifts with the previous shift's business date", () => {
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 0);
    expect(rows.map(brief)).toEqual([
      "Shift 1|2026-09-14|09-14T06:00→09-14T12:00|S",
      "Off Hours|2026-09-14|09-14T12:00→09-14T14:00|N",
      "Shift 2|2026-09-14|09-14T14:00→09-14T20:00|S",
      "Off Hours|2026-09-14|09-14T20:00→09-14T22:00|N",
      "Shift 3|2026-09-14|09-14T22:00→09-15T04:00|S",
    ]);
  });

  it("cuts a weekend gap every 24h from the day's first shift, one row per business date", () => {
    // Fri 09-18 through Mon 09-21
    const rows = buildInstanceRows(assignment, day("2026-09-18").getTime(), 3);
    const gaps = rows.filter(
      (r) =>
        r.definitionId === null &&
        r.startTime >= new Date("2026-09-19T04:00:00Z") &&
        r.startTime < new Date("2026-09-21T06:00:00Z"),
    );
    expect(gaps.map(brief)).toEqual([
      "Off Hours|2026-09-18|09-19T04:00→09-19T06:00|N",
      "Off Hours|2026-09-19|09-19T06:00→09-20T06:00|N",
      "Off Hours|2026-09-20|09-20T06:00→09-21T06:00|N",
    ]);
    expect(rows.at(-1)?.shiftName).toBe("Shift 3"); // trailing gap not emitted
    expect(hasOverlappingRows(rows)).toBe(false);
  });

  it("does not emit a gap after the last row", () => {
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 1);
    expect(rows.at(-1)?.shiftName).toBe("Shift 3");
    expect(rows.filter((r) => !r.isScheduled)).toHaveLength(5);
  });

  it("preserved in-use rows are kept, avoided, and get gaps on both sides", () => {
    const [s1, , s3] = buildInstanceRows(assignment, day("2026-09-14").getTime(), 0).filter((r) => r.isScheduled);
    // An in-use Shift 2 that was retimed to start 30 minutes late stays as it is.
    const kept = {
      ...s1,
      definitionId: "d1s2",
      shiftName: "Shift 2",
      startTime: new Date("2026-09-14T14:30:00Z"),
      endTime: new Date("2026-09-14T20:00:00Z"),
    };
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 0, [kept]);
    expect(rows.map(brief)).toEqual([
      "Shift 1|2026-09-14|09-14T06:00→09-14T12:00|S",
      "Off Hours|2026-09-14|09-14T12:00→09-14T14:30|N",
      "Shift 2|2026-09-14|09-14T14:30→09-14T20:00|S",
      "Off Hours|2026-09-14|09-14T20:00→09-14T22:00|N",
      "Shift 3|2026-09-14|09-14T22:00→09-15T04:00|S",
    ]);
    expect(rows[2]).toBe(kept);
    expect(s3.shiftName).toBe("Shift 3");
  });
});

describe("buildInstanceRows rotation end", () => {
  it("is an instant: shifts starting at or after it are not built", () => {
    const ended = { ...assignment, rotationEndDate: new Date("2026-09-15T12:00:00Z") };
    const rows = buildInstanceRows(ended, day("2026-09-14").getTime(), 3, [], "UTC", []).filter((r) => r.isScheduled);
    expect(rows.map((r) => `${r.businessDate.toISOString().slice(0, 10)} ${r.shiftName}`)).toEqual([
      "2026-09-14 Shift 1",
      "2026-09-14 Shift 2",
      "2026-09-14 Shift 3",
      "2026-09-15 Shift 1",
    ]);
  });
});

describe("buildInstanceRows preserved rows", () => {
  it("keeps existing rows before a moved-forward rotation start and fills gaps around them", () => {
    // Rows the tick wrote under the old rotation (Sun 09-13); the rotation now starts Mon 09-14.
    const old = buildInstanceRows(
      { ...assignment, rotationStartDate: day("2026-09-13") },
      day("2026-09-13").getTime(),
      1,
    ).filter((r) => r.isScheduled && r.businessDate.getTime() === day("2026-09-13").getTime());
    expect(old).toHaveLength(3);
    const rows = buildInstanceRows(assignment, day("2026-09-13").getTime(), 2, old);
    const on13 = rows.filter((r) => r.businessDate.getTime() === day("2026-09-13").getTime());
    expect(on13.map(brief)).toEqual([
      "Shift 1|2026-09-13|09-13T06:00→09-13T12:00|S",
      `${OFF_HOURS_NAME}|2026-09-13|09-13T12:00→09-13T14:00|N`,
      "Shift 2|2026-09-13|09-13T14:00→09-13T20:00|S",
      `${OFF_HOURS_NAME}|2026-09-13|09-13T20:00→09-13T22:00|N`,
      "Shift 3|2026-09-13|09-13T22:00→09-14T04:00|S",
      `${OFF_HOURS_NAME}|2026-09-13|09-14T04:00→09-14T06:00|N`,
    ]);
    expect(hasOverlappingRows(rows.filter((r) => !r.isScheduled || r.definitionId))).toBe(false);
  });
});

describe("buildInstanceRows overrides", () => {
  it("switched-off shift keeps its window and name, unscheduled", () => {
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 0, [], "UTC", [
      {
        businessDate: day("2026-09-14"),
        shiftName: "Shift 2",
        startTime: null,
        endTime: null,
        isScheduled: false,
        note: "Holiday",
      },
    ]);
    expect(rows.map(brief)).toEqual([
      "Shift 1|2026-09-14|09-14T06:00→09-14T12:00|S",
      "Off Hours|2026-09-14|09-14T12:00→09-14T14:00|N",
      "Shift 2|2026-09-14|09-14T14:00→09-14T20:00|N",
      "Off Hours|2026-09-14|09-14T20:00→09-14T22:00|N",
      "Shift 3|2026-09-14|09-14T22:00→09-15T04:00|S",
    ]);
    expect(rows[2].definitionId).toBe("d1s2");
  });

  it("whole-day cancel applies to every shift unless a shift-specific override wins", () => {
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 0, [], "UTC", [
      {
        businessDate: day("2026-09-14"),
        shiftName: null,
        startTime: null,
        endTime: null,
        isScheduled: false,
        note: null,
      },
      {
        businessDate: day("2026-09-14"),
        shiftName: "Shift 3",
        startTime: new Date("2026-09-14T21:00:00Z"),
        endTime: new Date("2026-09-15T03:00:00Z"),
        isScheduled: null,
        note: null,
      },
    ]);
    expect(rows.filter((r) => r.definitionId).map(brief)).toEqual([
      "Shift 1|2026-09-14|09-14T06:00→09-14T12:00|N",
      "Shift 2|2026-09-14|09-14T14:00→09-14T20:00|N",
      "Shift 3|2026-09-14|09-14T21:00→09-15T03:00|S",
    ]);
  });

  it("retimed shift keeps its business date and the gaps follow the new window", () => {
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 0, [], "UTC", [
      {
        businessDate: day("2026-09-14"),
        shiftName: "Shift 1",
        startTime: new Date("2026-09-14T07:00:00Z"),
        endTime: new Date("2026-09-14T13:00:00Z"),
        isScheduled: null,
        note: null,
      },
    ]);
    expect(rows.slice(0, 2).map(brief)).toEqual([
      "Shift 1|2026-09-14|09-14T07:00→09-14T13:00|S",
      "Off Hours|2026-09-14|09-14T13:00→09-14T14:00|N",
    ]);
  });

  it("overrides only touch their own business date", () => {
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 1, [], "UTC", [
      {
        businessDate: day("2026-09-15"),
        shiftName: null,
        startTime: null,
        endTime: null,
        isScheduled: false,
        note: "Down",
      },
    ]);
    const byDate = (d: string) =>
      rows.filter((r) => r.definitionId && iso(r.businessDate) === d).map((r) => r.shiftName);
    expect(byDate("2026-09-14")).toEqual(["Shift 1", "Shift 2", "Shift 3"]);
    expect(byDate("2026-09-15")).toEqual(["Shift 1", "Shift 2", "Shift 3"]);
  });
});

describe("hasOverlappingRows", () => {
  it("detects an override window that runs into the next shift", () => {
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 0, [], "UTC", [
      {
        businessDate: day("2026-09-14"),
        shiftName: "Shift 1",
        startTime: new Date("2026-09-14T06:00:00Z"),
        endTime: new Date("2026-09-14T15:00:00Z"),
        isScheduled: null,
        note: null,
      },
    ]);
    expect(hasOverlappingRows(rows.filter((r) => r.definitionId))).toBe(true);
  });
});

describe("added shifts", () => {
  it("a timed override for a name the pattern lacks that day adds a scheduled shift", () => {
    // Saturday 09-19 has no pattern shifts; add one and the weekend gap closes around it.
    const rows = buildInstanceRows(assignment, day("2026-09-18").getTime(), 3, [], "UTC", [
      {
        businessDate: day("2026-09-19"),
        shiftName: "Saturday OT",
        startTime: new Date("2026-09-19T10:00:00Z"),
        endTime: new Date("2026-09-19T16:00:00Z"),
        isScheduled: null,
        note: null,
      },
    ]);
    const sat = rows.filter(
      (r) => r.startTime >= new Date("2026-09-19T04:00:00Z") && r.startTime < new Date("2026-09-20T06:00:00Z"),
    );
    expect(sat.map(brief)).toEqual([
      "Off Hours|2026-09-18|09-19T04:00→09-19T06:00|N",
      "Off Hours|2026-09-19|09-19T06:00→09-19T10:00|N",
      "Saturday OT|2026-09-19|09-19T10:00→09-19T16:00|S",
      "Off Hours|2026-09-19|09-19T16:00→09-20T10:00|N",
    ]);
    expect(sat[2].definitionId).toBeNull();
  });

  it("a timed override matching an existing shift retimes instead of adding", () => {
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 0, [], "UTC", [
      {
        businessDate: day("2026-09-14"),
        shiftName: "Shift 1",
        startTime: new Date("2026-09-14T07:00:00Z"),
        endTime: new Date("2026-09-14T13:00:00Z"),
        isScheduled: null,
        note: null,
      },
    ]);
    expect(rows.filter((r) => r.shiftName === "Shift 1")).toHaveLength(1);
  });
});

describe("local wall-clock definitions", () => {
  // Rockware shape: Shift 1 at 23:00 Eastern the evening before the rotation day.
  const eastern: AssignmentWithPattern = {
    ...assignment,
    pattern: {
      totalDaysInRotation: 1,
      useEndDateForBusinessDate: true,
      shifts: [
        {
          id: "s1",
          dayOfRotation: 1,
          sortOrder: 1,
          startDayOffset: -1,
          startTime: "23:00",
          durationHrs: 8,
          shiftName: "Shift 1",
          isScheduled: true,
        },
        {
          id: "s2",
          dayOfRotation: 1,
          sortOrder: 2,
          startDayOffset: 0,
          startTime: "07:00",
          durationHrs: 8,
          shiftName: "Shift 2",
          isScheduled: true,
        },
        {
          id: "s3",
          dayOfRotation: 1,
          sortOrder: 3,
          startDayOffset: 0,
          startTime: "15:00",
          durationHrs: 8,
          shiftName: "Shift 3",
          isScheduled: true,
        },
      ],
    },
  };

  it("keeps 23:00 local across the November DST change (UTC instant moves an hour)", () => {
    const rows = buildInstanceRows(eastern, day("2026-10-31").getTime(), 1, [], "America/New_York").filter(
      (r) => r.shiftName === "Shift 1",
    );
    expect(rows.map((r) => `${iso(r.businessDate)} ${r.startTime.toISOString()}`)).toEqual([
      "2026-10-31 2026-10-31T03:00:00.000Z", // 23:00 EDT on Oct 30
      "2026-11-01 2026-11-01T03:00:00.000Z", // 23:00 EDT on Oct 31 (change is 02:00 Nov 1)
    ]);
    const after = buildInstanceRows(eastern, day("2026-11-02").getTime(), 0, [], "America/New_York").find(
      (r) => r.shiftName === "Shift 1",
    );
    expect(after?.startTime.toISOString()).toBe("2026-11-02T04:00:00.000Z"); // 23:00 EST on Nov 1
  });

  it("the changeover night shift runs 23:00→07:00 local: 9 elapsed hours, no gap, no overlap", () => {
    const rows = buildInstanceRows(eastern, day("2026-11-01").getTime(), 0, [], "America/New_York");
    expect(rows.map(brief)).toEqual([
      "Shift 1|2026-11-01|11-01T03:00→11-01T12:00|S", // 23:00 EDT → 07:00 EST
      "Shift 2|2026-11-01|11-01T12:00→11-01T20:00|S",
      "Shift 3|2026-11-01|11-01T20:00→11-02T04:00|S",
    ]);
  });
});

describe("DST edge cases", () => {
  const night = (durationHrs: number, second?: { startTime: string; durationHrs: number }): AssignmentWithPattern => ({
    ...assignment,
    rotationStartDate: day("2026-01-01"),
    pattern: {
      totalDaysInRotation: 1,
      useEndDateForBusinessDate: false,
      shifts: [
        {
          id: "n",
          dayOfRotation: 1,
          sortOrder: 1,
          startDayOffset: 0,
          startTime: "23:00",
          durationHrs,
          shiftName: "Night",
          isScheduled: true,
        },
        ...(second
          ? [
              {
                id: "e",
                dayOfRotation: 1,
                sortOrder: 2,
                startDayOffset: 1,
                startTime: second.startTime,
                durationHrs: second.durationHrs,
                shiftName: "Early",
                isScheduled: true,
              },
            ]
          : []),
      ],
    },
  });
  const utc = (rows: InstanceRow[], name: string) => {
    const r = rows.find((x) => x.shiftName === name) as InstanceRow;
    return `${r.startTime.toISOString().slice(5, 16)}→${r.endTime.toISOString().slice(5, 16)}`;
  };

  it("a wall-clock time inside the spring-forward gap resolves forward, not backward", () => {
    // 2026-03-08: 02:00 EST → 03:00 EDT. 23:00 + 3.5h = "02:30", which never happens.
    const rows = buildInstanceRows(
      night(3.5, { startTime: "02:30", durationHrs: 4 }),
      day("2026-03-07").getTime(),
      0,
      [],
      "America/New_York",
    );
    expect(utc(rows, "Night")).toBe("03-08T04:00→03-08T07:30"); // ends 03:30 EDT, after the gap
    expect(utc(rows, "Early")).toBe("03-08T07:30→03-08T10:30"); // starts 03:30 EDT, ends 06:30 EDT, no overlap
  });

  it("a wall-clock time that happens twice on the fall-back night takes its first occurrence", () => {
    // 2026-11-01: 02:00 EDT → 01:00 EST. 23:00 + 2.5h = "01:30", which happens twice.
    const rows = buildInstanceRows(night(2.5), day("2026-10-31").getTime(), 0, [], "America/New_York");
    expect(utc(rows, "Night")).toBe("11-01T03:00→11-01T05:30"); // 01:30 EDT
  });

  it("east of UTC: the spring gap still resolves forward and the fall repeat to its first occurrence", () => {
    // Europe/Berlin 2026-03-29: 02:00 CET → 03:00 CEST; 2026-10-25: 03:00 CEST → 02:00 CET.
    const spring = buildInstanceRows(night(3.5), day("2026-03-28").getTime(), 0, [], "Europe/Berlin");
    expect(utc(spring, "Night")).toBe("03-28T22:00→03-29T01:30"); // ends 03:30 CEST
    const fall = buildInstanceRows(night(3.5), day("2026-10-24").getTime(), 0, [], "Europe/Berlin");
    expect(utc(fall, "Night")).toBe("10-24T21:00→10-25T00:30"); // 02:30 CEST, first occurrence
  });
});

describe("scheduled flag", () => {
  const weekend: AssignmentWithPattern = {
    ...assignment,
    pattern: {
      ...assignment.pattern,
      shifts: [
        ...assignment.pattern.shifts,
        // Saturday kept on the rotation but not worked by default
        {
          id: "d6s1",
          dayOfRotation: 6,
          sortOrder: 1,
          startDayOffset: 0,
          startTime: "06:00",
          durationHrs: 8,
          shiftName: "Shift 1",
          isScheduled: false,
        },
      ],
    },
  };

  it("an unscheduled definition yields an unscheduled row that keeps its name", () => {
    const sat = buildInstanceRows(weekend, day("2026-09-19").getTime(), 0).filter((r) => r.definitionId);
    expect(sat.map(brief)).toEqual(["Shift 1|2026-09-19|09-19T06:00→09-19T14:00|N"]);
  });

  it("an override with isScheduled=true switches it on for that date only", () => {
    const rows = buildInstanceRows(weekend, day("2026-09-19").getTime(), 7, [], "UTC", [
      {
        businessDate: day("2026-09-19"),
        shiftName: "Shift 1",
        startTime: null,
        endTime: null,
        isScheduled: true,
        note: null,
      },
    ]);
    const sats = rows.filter((r) => r.definitionId === "d6s1");
    expect(sats.map(brief)).toEqual([
      "Shift 1|2026-09-19|09-19T06:00→09-19T14:00|S",
      "Shift 1|2026-09-26|09-26T06:00→09-26T14:00|N",
    ]);
  });

  it("an override may retime and unschedule at once", () => {
    const rows = buildInstanceRows(assignment, day("2026-09-14").getTime(), 0, [], "UTC", [
      {
        businessDate: day("2026-09-14"),
        shiftName: "Shift 2",
        startTime: new Date("2026-09-14T15:00:00Z"),
        endTime: new Date("2026-09-14T19:00:00Z"),
        isScheduled: false,
        note: "Down",
      },
    ]);
    expect(rows.filter((r) => r.definitionId === "d1s2").map(brief)).toEqual([
      "Shift 2|2026-09-14|09-14T15:00→09-14T19:00|N",
    ]);
  });
});
