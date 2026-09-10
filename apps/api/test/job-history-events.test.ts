import {
  deriveJobHistoryEventSubject,
  isJobHistoryAmendedEvent,
  parseJobHistoryAmendedEvent,
} from "@rw/runtime/job-history-events";
import { describe, expect, it } from "vitest";

const baseEvent = {
  id: "e1",
  action: "amended",
  workspaceId: "w1",
  siteId: "s1",
  stationId: "st1",
  stationName: "Press 4",
  amendmentId: "a1",
  displacedJobIds: ["j1"],
  from: "2026-09-10T08:00:00.000Z",
  source: "MANUAL",
  emittedAt: "2026-09-10T09:00:00.000Z",
};

describe("job history event contract", () => {
  it("derives subjects", () => {
    expect(deriveJobHistoryEventSubject({ siteId: "site-1", stationId: "st-1", action: "amended" })).toBe(
      "job-history.site-1.st-1.amended",
    );
    expect(() => deriveJobHistoryEventSubject({ siteId: "", stationId: "st", action: "amended" })).toThrow();
  });

  it("accepts well-formed events with and without a job, end time and cause", () => {
    expect(isJobHistoryAmendedEvent(baseEvent)).toBe(true);
    expect(
      isJobHistoryAmendedEvent({
        ...baseEvent,
        jobId: "j2",
        jobName: "Lid",
        jobVersionId: "j2v",
        to: "2026-09-10T08:30:00.000Z",
        cause: { correlationId: "root", causationId: "parent", hop: 1 },
      }),
    ).toBe(true);
  });

  it("rejects malformed events", () => {
    expect(isJobHistoryAmendedEvent({ ...baseEvent, action: "changed" })).toBe(false);
    expect(isJobHistoryAmendedEvent({ ...baseEvent, displacedJobIds: "j1" })).toBe(false);
    expect(parseJobHistoryAmendedEvent({ ...baseEvent, amendmentId: undefined })).toBeNull();
  });
});
