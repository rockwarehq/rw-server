import { deriveModeEventSubject, isModeEvent, parseModeEvent } from "@rw/runtime/mode-events";
import { describe, expect, it } from "vitest";

const baseEvent = {
  id: "e1",
  action: "forced",
  logId: "l1",
  modeId: "m1",
  modeName: "Trial",
  workspaceId: "w1",
  siteId: "s1",
  stationId: "st1",
  stationName: "Press 4",
  source: "MANUAL",
  startedAt: "2026-09-02T00:00:00.000Z",
  emittedAt: "2026-09-02T00:00:00.000Z",
};

describe("mode event contract", () => {
  it("derives subjects and sanitizes wildcard-hostile tokens", () => {
    expect(deriveModeEventSubject({ siteId: "site-1", stationId: "st-1", action: "forced" })).toBe(
      "modes.site-1.st-1.forced",
    );
    expect(deriveModeEventSubject({ siteId: "a b", stationId: "x*y", action: "cleared" })).toBe("modes.a_b.x_y.cleared");
    expect(() => deriveModeEventSubject({ siteId: "", stationId: "st", action: "forced" })).toThrow();
  });

  it("accepts well-formed events, including cleared events with end fields and a cause", () => {
    expect(isModeEvent(baseEvent)).toBe(true);
    expect(
      isModeEvent({
        ...baseEvent,
        action: "cleared",
        source: "SYSTEM",
        sourceType: "automation",
        sourceRef: "auto-1",
        endedAt: "2026-09-02T01:00:00.000Z",
        endedByEmployeeId: "emp1",
        cause: { correlationId: "root", causationId: "parent", hop: 1 },
      }),
    ).toBe(true);
  });

  it("rejects malformed events", () => {
    expect(isModeEvent(null)).toBe(false);
    expect(isModeEvent({ ...baseEvent, action: "switched" })).toBe(false);
    expect(isModeEvent({ ...baseEvent, source: "ROBOT" })).toBe(false);
    expect(isModeEvent({ ...baseEvent, cause: { correlationId: "root" } })).toBe(false);
    expect(parseModeEvent({ ...baseEvent, modeId: undefined })).toBeNull();
    expect(parseModeEvent(baseEvent)).toEqual(baseEvent);
  });
});
