import { describe, expect, it } from "vitest";
import { recapPageScope } from "./index.js";
import { type DeckSlide, deckShapeProblem } from "./types.js";

const slide = (overrides: Partial<DeckSlide> = {}): DeckSlide => ({
  id: "s1",
  kind: "shift-recap",
  title: "Shift recap",
  params: {},
  shiftNames: ["2nd"],
  queries: {},
  ...overrides,
});

describe("deckShapeProblem", () => {
  it("keeps a deck to days", () => {
    expect(deckShapeProblem("DECK", "yesterday-7", [slide({ kind: "catalog" })])).toBeNull();
    expect(deckShapeProblem("DECK", "last-shift", [])).not.toBeNull();
  });

  it("makes a shift recap one recap page for one shift name over the last shift", () => {
    expect(deckShapeProblem("SHIFT_RECAP", "last-shift", [slide()])).toBeNull();
    expect(deckShapeProblem("SHIFT_RECAP", "yesterday", [slide()])).not.toBeNull();
    expect(deckShapeProblem("SHIFT_RECAP", "last-shift", [])).not.toBeNull();
    expect(deckShapeProblem("SHIFT_RECAP", "last-shift", [slide(), slide({ id: "s2" })])).not.toBeNull();
    expect(deckShapeProblem("SHIFT_RECAP", "last-shift", [slide({ kind: "production" })])).not.toBeNull();
    expect(deckShapeProblem("SHIFT_RECAP", "last-shift", [slide({ shiftNames: [] })])).not.toBeNull();
    expect(deckShapeProblem("SHIFT_RECAP", "last-shift", [slide({ shiftNames: ["1st", "2nd"] })])).not.toBeNull();
  });
});

describe("recapPageScope", () => {
  const WORKCENTER = "22222222-2222-4222-8222-222222222222";
  const SHIFT = "44444444-4444-4444-8444-444444444444";
  const shift = { id: SHIFT, shiftName: "2nd", businessDate: "2026-09-25", startTime: "", endTime: "" };
  const edition = {
    setup: { workcenterId: WORKCENTER, slides: [slide(), slide({ id: "p", kind: "production" })] },
    pages: [
      { key: `s1:${SHIFT}`, slideId: "s1", shifts: [shift] },
      { key: "p:all", slideId: "p", shifts: [shift] },
      { key: "s1:none", slideId: "s1", shifts: null },
    ],
  };

  it("reads the workcenter and shift the edition kept for a recap page", () => {
    expect(recapPageScope(edition, `s1:${SHIFT}`)).toEqual({ workCenterId: WORKCENTER, shiftInstanceId: SHIFT });
  });

  it("opens nothing for another kind of page, a page with no one shift, or a page not there", () => {
    expect(recapPageScope(edition, "p:all")).toBeNull();
    expect(recapPageScope(edition, "s1:none")).toBeNull();
    expect(recapPageScope(edition, "nope")).toBeNull();
  });
});
