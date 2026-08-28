import { deriveCallEventSubject, isCallEvent, parseCallEvent } from "@rw/runtime/call-events";
import { describe, expect, it } from "vitest";

const baseEvent = {
  id: "e1",
  action: "opened",
  callId: "c1",
  definitionId: "d1",
  definitionName: "Maintenance Required",
  severity: "ALERT",
  workspaceId: "w1",
  siteId: "s1",
  stationId: "st1",
  stationName: "Press 4",
  source: "MANUAL",
  openedAt: "2026-08-28T00:00:00.000Z",
  emittedAt: "2026-08-28T00:00:00.000Z",
};

describe("call event contract", () => {
  it("derives subjects and sanitizes wildcard-hostile tokens", () => {
    expect(deriveCallEventSubject({ siteId: "site-1", callId: "call-1", action: "opened" })).toBe(
      "calls.site-1.call-1.opened",
    );
    expect(deriveCallEventSubject({ siteId: "a b", callId: "x*y", action: "closed" })).toBe("calls.a_b.x_y.closed");
    expect(() => deriveCallEventSubject({ siteId: "", callId: "c", action: "opened" })).toThrow();
  });

  it("accepts well-formed events, including closed events with close fields", () => {
    expect(isCallEvent(baseEvent)).toBe(true);
    expect(
      isCallEvent({
        ...baseEvent,
        action: "closed",
        source: "SYSTEM",
        sourceType: "station.down",
        closedAt: "2026-08-28T01:00:00.000Z",
        closedByEmployeeId: "emp1",
        closeMessage: "fixed",
      }),
    ).toBe(true);
  });

  it("rejects malformed events", () => {
    expect(isCallEvent(null)).toBe(false);
    expect(isCallEvent([])).toBe(false);
    expect(isCallEvent({ ...baseEvent, action: "reopened" })).toBe(false);
    expect(isCallEvent({ ...baseEvent, severity: "CRITICAL" })).toBe(false);
    expect(isCallEvent({ ...baseEvent, sourceRef: 42 })).toBe(false);
    expect(parseCallEvent({ ...baseEvent, callId: undefined })).toBeNull();
    expect(parseCallEvent(baseEvent)).toEqual(baseEvent);
  });
});
