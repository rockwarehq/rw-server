import { describe, expect, it } from "vitest";
import { deckDays, type ShiftRow } from "./days.js";

const at = (iso: string) => Date.parse(iso);
const shift = (id: string, date: string, start: string, end: string, name = "1st"): ShiftRow => ({
  id,
  shiftName: name,
  businessDate: date,
  startMs: at(`${start}Z`),
  endMs: at(`${end}Z`),
});

// Thu 24 – Fri 25 worked, a weekend with no shifts, Mon 28 running.
const SHIFTS = [
  shift("thu-1", "2026-09-24", "2026-09-24T06:00", "2026-09-24T14:00"),
  shift("thu-2", "2026-09-24", "2026-09-24T14:00", "2026-09-24T22:00", "2nd"),
  shift("fri-1", "2026-09-25", "2026-09-25T06:00", "2026-09-25T14:00"),
  // The night shift belongs to Friday and ends Saturday morning.
  shift("fri-3", "2026-09-25", "2026-09-25T22:00", "2026-09-26T06:00", "3rd"),
  shift("mon-1", "2026-09-28", "2026-09-28T06:00", "2026-09-28T14:00"),
];

describe("deckDays", () => {
  it("makes Monday's yesterday the last day that worked", () => {
    const days = deckDays("yesterday", SHIFTS, at("2026-09-28T07:00Z"));
    expect(days).toMatchObject({ dateFrom: "2026-09-25", dateTo: "2026-09-25" });
    expect(days?.shifts.map((s) => s.id)).toEqual(["fri-1", "fri-3"]);
  });

  it("waits for a day's last shift, night shift included", () => {
    expect(deckDays("yesterday", SHIFTS, at("2026-09-26T05:00Z"))?.dateTo).toBe("2026-09-24");
    expect(deckDays("yesterday", SHIFTS, at("2026-09-26T06:00Z"))?.dateTo).toBe("2026-09-25");
  });

  it("counts seven calendar days back from that day", () => {
    const days = deckDays("yesterday-7", SHIFTS, at("2026-09-28T07:00Z"));
    expect(days).toMatchObject({ dateFrom: "2026-09-19", dateTo: "2026-09-25" });
    expect(days?.shifts.map((s) => s.id)).toEqual(["thu-1", "thu-2", "fri-1", "fri-3"]);
  });

  it("has no days before any has finished", () => {
    expect(deckDays("yesterday", SHIFTS, at("2026-09-24T13:00Z"))).toBeNull();
  });
});

describe("deckDays: last shift", () => {
  it("is the latest finished shift of that name, whatever day it was", () => {
    // Monday morning: the last 3rd shift is Friday's, which ended Saturday.
    const days = deckDays("last-shift", SHIFTS, at("2026-09-28T07:00Z"), ["3rd"]);
    expect(days).toMatchObject({ dateFrom: "2026-09-25", dateTo: "2026-09-25" });
    expect(days?.shifts.map((s) => s.id)).toEqual(["fri-3"]);
  });

  it("waits for the shift to end, and falls back to the one before", () => {
    expect(deckDays("last-shift", SHIFTS, at("2026-09-28T13:00Z"), ["1st"])?.shifts[0]?.id).toBe("fri-1");
    expect(deckDays("last-shift", SHIFTS, at("2026-09-28T14:00Z"), ["1st"])?.shifts[0]?.id).toBe("mon-1");
  });

  it("matches the name ignoring case and spaces", () => {
    expect(deckDays("last-shift", SHIFTS, at("2026-09-28T07:00Z"), [" 2ND "])?.shifts[0]?.id).toBe("thu-2");
  });

  it("has none when no shift of that name has finished", () => {
    expect(deckDays("last-shift", SHIFTS, at("2026-09-28T07:00Z"), ["Weekend"])).toBeNull();
  });
});
