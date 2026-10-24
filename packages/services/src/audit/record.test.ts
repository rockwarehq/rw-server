import { describe, expect, it } from "vitest";

import { changedValues } from "./record.js";

describe("changedValues", () => {
  it("compares values as the trail stores them", () => {
    const changes = changedValues(
      { weight: { toNumber: () => 4 }, at: new Date("2026-10-24T00:00:00Z"), name: "Cap" },
      { weight: { toNumber: () => 4 }, at: new Date("2026-10-24T00:00:00Z"), name: "Lid" },
      ["weight", "at", "name"],
    );
    expect(changes).toEqual({ name: { from: "Cap", to: "Lid" } });
  });

  it("tells apart two records with the same name by their ids, and shows the names", () => {
    const before = { tool: "Mold A" };
    const after = { tool: "Mold A" };
    expect(changedValues(before, after, ["tool"])).toEqual({});
    expect(changedValues(before, after, ["tool"], { tool: { before: "t1", after: "t2" } })).toEqual({
      tool: { from: "Mold A", to: "Mold A" },
    });
    expect(changedValues({ tool: "Mold A" }, { tool: "Mold B" }, ["tool"], { tool: { before: "t1", after: "t1" } })).toEqual(
      {},
    );
  });
});
