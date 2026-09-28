import { describe, expect, it } from "vitest";
import { compileReportQuery, compileReportRows } from "./compiler.js";
import { resolveDateRange } from "./dates.js";
import { FACTS } from "./facts.js";
import { describeView, listViewsForAi, reportSchema, searchCatalog } from "./index.js";
import { VIEWS } from "./views.js";

const scope = { siteId: "11111111-1111-4111-8111-111111111111" };
const flat = (sql: { sql: string }) => sql.sql.replace(/\s+/g, " ").trim();

describe("catalog text", () => {
  it("gives every measure and dimension a description", () => {
    const missing: string[] = [];
    for (const [factKey, fact] of Object.entries(FACTS)) {
      for (const [key, m] of Object.entries(fact.measures)) if (!m.description) missing.push(`${factKey}.${key}`);
      for (const [key, d] of Object.entries(fact.dimensions)) if (!d.description) missing.push(`${factKey}.${key}`);
    }
    expect(missing).toEqual([]);
  });

  it("marks material quantity as needing the unit", () => {
    expect(FACTS.materialUsage?.measures.quantity?.requiresDimensions).toEqual(["unit"]);
    expect(FACTS.materialLedger?.measures.quantity?.requiresDimensions).toEqual(["unit"]);
  });

  it("shows segments and descriptions in the public schema", () => {
    const downtime = reportSchema().find((f) => f.key === "statePeriods");
    expect(downtime?.segments.map((s) => s.key)).toContain("unplannedDown");
    expect(downtime?.dimensions.find((d) => d.key === "station")?.description).toBeTruthy();
  });
});

describe("segments", () => {
  it("adds the catalog predicate to aggregate and detail queries", () => {
    const agg = compileReportQuery(
      { fact: "statePeriods", measures: ["downSeconds"], dimensions: [], segments: ["unplannedDown"] },
      scope,
    );
    if ("error" in agg) throw new Error(agg.error);
    expect(flat(agg)).toContain(`(f."state" = 'DOWN' AND f."isPlannedDown" IS NOT TRUE)`);

    const detail = compileReportRows({ fact: "calls", columns: ["station"], segments: ["open"] }, scope);
    if ("error" in detail) throw new Error(detail.error);
    expect(flat(detail.sql)).toContain(`(f."closedAt" IS NULL)`);
    expect(flat(detail.count)).toContain(`(f."closedAt" IS NULL)`);
  });

  it("refuses a segment the fact doesn't have", () => {
    const result = compileReportQuery(
      { fact: "cycles", measures: ["cycles"], dimensions: [], segments: ["unplannedDown"] },
      scope,
    );
    expect(result).toMatchObject({ code: "UNKNOWN_SEGMENT" });
  });
});

describe("required dimensions", () => {
  it("refuses material quantity without the unit", () => {
    const result = compileReportQuery(
      { fact: "materialUsage", measures: ["quantity"], dimensions: ["material"] },
      scope,
    );
    expect(result).toMatchObject({ code: "MISSING_REQUIRED_DIMENSION" });
  });

  it("allows it when grouped by unit, or pinned to one unit", () => {
    const grouped = compileReportQuery(
      { fact: "materialUsage", measures: ["quantity"], dimensions: ["material", "unit"] },
      scope,
    );
    expect("error" in grouped).toBe(false);
    const pinned = compileReportQuery(
      {
        fact: "materialUsage",
        measures: ["quantity"],
        dimensions: ["material"],
        filters: [{ dimension: "unit", op: "eq", value: "KG" }],
      },
      scope,
    );
    expect("error" in pinned).toBe(false);
  });

  it("doesn't stop measures that don't need it", () => {
    const result = compileReportQuery({ fact: "materialUsage", measures: ["itemCount"], dimensions: [] }, scope);
    expect("error" in result).toBe(false);
  });
});

describe("views", () => {
  it("only point at measures, dimensions and segments that exist", () => {
    for (const [key, view] of Object.entries(VIEWS)) {
      const fact = FACTS[view.fact];
      expect(fact, `${key}.fact`).toBeDefined();
      for (const m of view.measures) expect(fact?.measures[m], `${key}.${m}`).toBeDefined();
      for (const d of view.dimensions) expect(fact?.dimensions[d], `${key}.${d}`).toBeDefined();
      for (const s of view.segments ?? []) expect(fact?.segments?.[s], `${key}.${s}`).toBeDefined();
    }
  });

  it("never leak SQL to the AI", () => {
    const text = JSON.stringify([listViewsForAi(), Object.keys(VIEWS).map(describeView)]);
    expect(text).not.toMatch(/SELECT|LEFT JOIN|f\."|CASE WHEN/);
  });

  it("marks ratios and required dimensions for the AI", () => {
    const oee = describeView("oee");
    expect(oee?.measures.find((m) => m.key === "oee")?.ratio).toBe(true);
    expect(describeView("materials")?.measures.find((m) => m.key === "quantity")?.requires).toEqual(["unit"]);
    expect(describeView("nope")).toBeUndefined();
  });

  it("finds things by the words people use", () => {
    expect(searchCatalog("press downtime reasons").map((h) => h.view)).toContain("downtime");
    expect(searchCatalog("resin used")[0]?.view).toBe("materials");
    expect(searchCatalog("")).toEqual([]);
  });
});

describe("relative dates", () => {
  // Thursday 2026-09-24, 15:00 UTC.
  const now = Date.UTC(2026, 8, 24, 15);
  const on = (preset: Parameters<typeof resolveDateRange>[0]) => resolveDateRange(preset, "UTC", now);

  it("resolves weeks from Monday", () => {
    expect(on({ kind: "relative", preset: "this-week" })).toEqual({ dateFrom: "2026-09-21", dateTo: "2026-09-24" });
    expect(on({ kind: "relative", preset: "last-week" })).toEqual({ dateFrom: "2026-09-14", dateTo: "2026-09-20" });
  });

  it("resolves months and quarters", () => {
    expect(on({ kind: "relative", preset: "last-month" })).toEqual({ dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    expect(on({ kind: "relative", preset: "this-quarter" })).toEqual({ dateFrom: "2026-07-01", dateTo: "2026-09-24" });
  });

  it("uses the site's own date, not UTC", () => {
    // 01:00 UTC on the 25th is still the 24th in Chicago.
    const late = Date.UTC(2026, 8, 25, 1);
    expect(resolveDateRange({ kind: "relative", preset: "today" }, "America/Chicago", late)).toEqual({
      dateFrom: "2026-09-24",
      dateTo: "2026-09-24",
    });
  });

  it("passes absolute ranges through and leaves 'all' open", () => {
    expect(on({ kind: "absolute", from: "2026-01-01", to: "2026-01-31" })).toEqual({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(on({ kind: "all" })).toEqual({});
  });
});
