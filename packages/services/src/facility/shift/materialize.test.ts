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
