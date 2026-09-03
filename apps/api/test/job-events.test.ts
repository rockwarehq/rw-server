import { deriveJobEventSubject, isJobEvent, parseJobEvent } from "@rw/runtime/job-events";
import { describe, expect, it } from "vitest";

const baseEvent = {
  id: "e1",
  action: "changed",
  workspaceId: "w1",
  siteId: "s1",
  stationId: "st1",
  stationName: "Press 4",
  changedAt: "2026-09-03T00:00:00.000Z",
  source: "MANUAL",
  emittedAt: "2026-09-03T00:00:00.000Z",
};

describe("job event contract", () => {
  it("derives subjects", () => {
    expect(deriveJobEventSubject({ siteId: "site-1", stationId: "st-1", action: "changed" })).toBe(
      "jobs.site-1.st-1.changed",
    );
    expect(() => deriveJobEventSubject({ siteId: "", stationId: "st", action: "changed" })).toThrow();
  });

  it("accepts well-formed events with work context, previous job and cause", () => {
    expect(isJobEvent(baseEvent)).toBe(true);
    expect(
      isJobEvent({
        ...baseEvent,
        previousJobId: "j1",
        previousJobName: "Old",
        jobId: "j2",
        jobName: "New",
        workcenterId: "wc",
        shiftName: "Shift 1",
        businessDate: "2026-09-03",
        cause: { correlationId: "root", causationId: "parent", hop: 1 },
      }),
    ).toBe(true);
  });

  it("rejects malformed events", () => {
    expect(isJobEvent({ ...baseEvent, action: "cleared" })).toBe(false);
    expect(isJobEvent({ ...baseEvent, jobId: 42 })).toBe(false);
    expect(parseJobEvent({ ...baseEvent, stationId: undefined })).toBeNull();
  });
});
