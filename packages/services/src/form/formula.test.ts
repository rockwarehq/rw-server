import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { computeAll, type FormulaField, formulaCycle } from "./formula.js";

// The shared cases are a verbatim copy of rw-ui's apps/rw-imm/src/forms/formula.cases.json;
// both sides must produce these results.
interface Case {
  name: string;
  formula: string;
  answers: Record<string, unknown>;
  value?: number | boolean | null;
  waitingFor?: string[];
  error?: string;
}

const shared = JSON.parse(readFileSync(new URL("./formula.cases.json", import.meta.url), "utf8")) as {
  fields: FormulaField[];
  cases: Case[];
};

function computedField(formula: string, extra: Partial<FormulaField> = {}): FormulaField {
  return { id: "out", key: "out", type: "computed", label: "Out", formula, ...extra };
}

describe("shared formula cases (mirrored in rw-ui)", () => {
  for (const c of shared.cases) {
    test(c.name, () => {
      const result = computeAll([...shared.fields, computedField(c.formula)], c.answers).get("out");
      if (!result) throw new Error("no result for the computed field");
      if (c.error !== undefined) {
        expect(result.error).toBe(c.error);
        return;
      }
      expect(result.error).toBeNull();
      expect(result.value).toBe(c.value);
      if (c.waitingFor) expect(result.waitingFor).toEqual(c.waitingFor);
    });
  }
});

describe("computed fields that use each other", () => {
  test("works them out in dependency order, whatever the reading order", () => {
    const rate = computedField("scrap / inspected", { id: "rate", key: "rate" });
    const scrap = computedField("inspected - good", { id: "scrap", key: "scrap" });
    const results = computeAll([...shared.fields, rate, scrap], { f1: 40, f2: 38 });
    expect(results.get("scrap")?.value).toBe(2);
    expect(results.get("rate")?.value).toBe(0.05);
  });

  test("refuses a loop", () => {
    const a = computedField("b + 1", { id: "a", key: "a" });
    const b = computedField("a + 1", { id: "b", key: "b" });
    expect(formulaCycle([a, b]).map((f) => f.id)).toEqual(["a", "b"]);
    expect(computeAll([a, b], {}).get("a")?.error).toBe("These formulas use each other's results");
  });
});
