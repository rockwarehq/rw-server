import { describe, expect, test, vi } from "vitest";

vi.mock("@rw/db", async (importOriginal) => ({ ...(await importOriginal<object>()), default: {} }));

const { idleHourJob } = await import("./recalc.js");
const { deriveBucketKPIs } = await import("./compute.js");
type ActiveJobLog = import("./recalc.js").ActiveJobLog;

const at = (hhmm: string) => new Date(`2026-10-29T${hhmm}:00-04:00`);

// Line3 on trimlok-elk: I11474 at 150 s a cycle, 100 ft a cycle (40 ft/min).
const log = (overrides: Partial<ActiveJobLog> = {}): ActiveJobLog => ({
  id: "log-1",
  stationId: "line3",
  jobId: "i11474",
  jobVersionId: "i11474-v1",
  startTime: at("05:00"),
  endTime: null,
  standardCycle: 150,
  itemsPerCycle: 100,
  ...overrides,
});

const downHour = {
  durationTally: { runSeconds: 0, downSeconds: 3600, plannedDownSeconds: 0, unplannedDownSeconds: 3600 },
  effectiveDuration: 3600,
};
const noCycles = {
  cycleTally: { totalCycles: 0, totalItems: 0, idealCycleSeconds: 0, totalCycleSeconds: 0 },
  badItems: 0,
};

describe("idleHourJob", () => {
  test("prices an hour with no cycles from the job running in it", () => {
    const job = idleHourJob([log()], at("06:00"), at("07:00"), 0);
    expect(job).toMatchObject({ jobId: "i11474", standardCycle: 150, itemsPerCycle: 100 });
  });

  test("leaves an hour with cycles to their own average", () => {
    expect(idleHourJob([log()], at("06:00"), at("07:00"), 3)).toBeUndefined();
  });

  test("leaves an hour no job covers, or whose job has no standard, unpriced", () => {
    expect(idleHourJob([log({ startTime: at("08:00") })], at("06:00"), at("07:00"), 0)).toBeUndefined();
    expect(idleHourJob([log({ endTime: at("06:00") })], at("06:00"), at("07:00"), 0)).toBeUndefined();
    expect(idleHourJob([log({ standardCycle: null })], at("06:00"), at("07:00"), 0)).toBeUndefined();
  });

  test("takes the latest job when two share the hour", () => {
    const job = idleHourJob(
      [log({ endTime: at("06:30") }), log({ id: "log-2", jobId: "next", startTime: at("06:30"), standardCycle: 60 })],
      at("06:00"),
      at("07:00"),
      0,
    );
    expect(job?.jobId).toBe("next");
  });
});

describe("a rebuilt hour the station was down for all of", () => {
  test("expects the job's standard, as the live tick did, not nothing", () => {
    expect(deriveBucketKPIs(downHour, noCycles).expectedItems).toBe(0);
    const priced = deriveBucketKPIs(downHour, noCycles, idleHourJob([log()], at("05:00"), at("06:00"), 0));
    // 3600 s / 150 s = 24 cycles × 100 ft = 2,400 ft — 60 min at 40 ft/min.
    expect(priced.expectedItems).toBe(2400);
    expect(priced.elapsedExpectedItems).toBe(2400);
    expect(priced.totalItems).toBe(0);
  });
});
