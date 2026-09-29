import { describe, expect, it } from "vitest";
import { runEventId } from "../src/automations/clock.js";

// Tier 1: a clock run's event id is the same every time the run is delivered,
// so a redelivered tick dedupes instead of sending again.
describe("clock run event ids", () => {
  const runAt = new Date("2026-09-29T11:00:00Z");

  it("are a UUID, the same for the same run", () => {
    const id = runEventId("automation-1", runAt);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(runEventId("automation-1", runAt)).toBe(id);
  });

  it("differ by automation and by run", () => {
    const id = runEventId("automation-1", runAt);
    expect(runEventId("automation-2", runAt)).not.toBe(id);
    expect(runEventId("automation-1", new Date("2026-09-30T11:00:00Z"))).not.toBe(id);
  });
});
