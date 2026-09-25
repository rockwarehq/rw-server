import { describe, expect, it } from "vitest";
import { checkEligibility, type EligibilityJob, type EligibilityStation } from "./eligibility.js";

const press: EligibilityStation = {
  name: "Press 3",
  cycleMode: "DISCRETE",
  quantityUnit: "",
  countedAs: "CYCLES",
  jobFilterLabels: [],
};

const moldingJob: EligibilityJob = {
  name: "WK-0421",
  labelIds: ["l-300t"],
  profile: { cycleMode: "DISCRETE", countedAs: "CYCLES", quantityUnit: "" },
};

describe("checkEligibility", () => {
  it("fits: same kind, no filter", () => {
    expect(checkEligibility(press, moldingJob)).toEqual([]);
  });

  it("blocked by kind", () => {
    const extruder = {
      ...press,
      name: "Line 2",
      cycleMode: "QUANTITY_PER_CYCLE" as const,
      quantityUnit: "ft",
      countedAs: "OUTPUT" as const,
    };
    const [reason] = checkEligibility(extruder, moldingJob);
    expect(reason.code).toBe("PROFILE_MISMATCH");
    expect(reason.message).toContain("Count by cycle");
  });

  it("blocked by the station's job label filter, with the labels it wants", () => {
    const filtered = { ...press, jobFilterLabels: [{ id: "l-500t", name: "500T" }] };
    const [reason] = checkEligibility(filtered, moldingJob);
    expect(reason.code).toBe("LABEL_FILTER_MISMATCH");
    expect(reason.labels).toEqual([{ id: "l-500t", name: "500T" }]);
  });

  it("a job carrying one of the filter's labels passes", () => {
    const filtered = {
      ...press,
      jobFilterLabels: [
        { id: "l-300t", name: "300T" },
        { id: "x", name: "X" },
      ],
    };
    expect(checkEligibility(filtered, moldingJob)).toEqual([]);
  });

  it("both gates can fail at once", () => {
    const station = {
      ...press,
      cycleMode: "QUANTITY_PER_INTERVAL" as const,
      quantityUnit: "ea",
      jobFilterLabels: [{ id: "l-500t", name: "500T" }],
    };
    expect(checkEligibility(station, moldingJob).map((r) => r.code)).toEqual([
      "PROFILE_MISMATCH",
      "LABEL_FILTER_MISMATCH",
    ]);
  });

  it("a job with no profile counts as the Discrete default", () => {
    const legacy = { ...moldingJob, profile: null };
    const extruder = { ...press, cycleMode: "QUANTITY_PER_CYCLE" as const, quantityUnit: "ft" };
    expect(checkEligibility(press, legacy)).toEqual([]);
    expect(checkEligibility(extruder, legacy).map((r) => r.code)).toEqual(["PROFILE_MISMATCH"]);
  });

  it("a job with no profile but a rate only meets the label gate", () => {
    const legacy = { ...moldingJob, profile: null, hasRate: true };
    const extruder = { ...press, cycleMode: "QUANTITY_PER_CYCLE" as const, quantityUnit: "ft" };
    expect(checkEligibility(extruder, legacy)).toEqual([]);
  });
});
