import { describe, expect, test } from "vitest";
import { summarizeUsage } from "./tool-usage.js";

const run = (stationId: string, startIso: string, jobName: string | null = "WK002 C") => ({
  stationId,
  startTime: new Date(startIso),
  endTime: null,
  station: { name: `Press ${stationId}` },
  jobId: `job-${stationId}`,
  job: { currentVersion: jobName === null ? null : { name: jobName } },
});

describe("summarizeUsage", () => {
  test("lists each station running a job that uses the tool, earliest first", () => {
    const usage = summarizeUsage([run("7", "2026-09-24T09:00:00Z"), run("4", "2026-09-24T06:14:00Z")], null);
    expect(usage.running).toEqual([
      {
        stationId: "4",
        stationName: "Press 4",
        jobId: "job-4",
        jobName: "WK002 C",
        since: new Date("2026-09-24T06:14:00Z"),
      },
      {
        stationId: "7",
        stationName: "Press 7",
        jobId: "job-7",
        jobName: "WK002 C",
        since: new Date("2026-09-24T09:00:00Z"),
      },
    ]);
    // While it runs, "last used" is not a thing to report.
    expect(usage.lastUsedAt).toBeNull();
  });

  test("keeps a station once, at the earlier start, if it has two open runs", () => {
    const usage = summarizeUsage([run("4", "2026-09-24T08:00:00Z"), run("4", "2026-09-24T06:00:00Z")], null);
    expect(usage.running).toHaveLength(1);
    expect(usage.running[0]?.since).toEqual(new Date("2026-09-24T06:00:00Z"));
  });

  test("reports when it was last in use when nothing is running", () => {
    const ended = new Date("2026-09-12T14:30:00Z");
    expect(summarizeUsage([], { endTime: ended })).toEqual({ running: [], lastUsedAt: ended });
  });

  test("says nothing about last use for a tool that never ran", () => {
    expect(summarizeUsage([], null)).toEqual({ running: [], lastUsedAt: null });
  });

  test("tolerates a job with no current version", () => {
    expect(summarizeUsage([run("4", "2026-09-24T06:00:00Z", null)], null).running[0]?.jobName).toBeNull();
  });
});
