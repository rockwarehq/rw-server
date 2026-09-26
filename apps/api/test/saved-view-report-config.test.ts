import { describe, expect, it } from "vitest";
import { createInputSchema, updateInputSchema } from "../src/rpc/saved-view.js";

// Pure input-schema tests for the "report" saved-view page (no DB). The
// config mirrors report.ts querySchema bounds; keys are intentionally NOT
// validated against the report catalog (report.query re-validates at read
// time), while shape and size limits are enforced here.

const SITE_ID = "5f0e8f7a-3c1d-4b2a-9e6f-1a2b3c4d5e6f";
const VIEW_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

const baseCreate = {
  siteId: SITE_ID,
  name: "Downtime by status reason",
  visibility: "PRIVATE" as const,
};

const validConfig = {
  v: 1 as const,
  fact: "statePeriods",
  measures: ["durationSeconds"],
  dimensions: ["statusReason", "businessDate"],
  filters: [{ dimension: "station", op: "in" as const, value: ["a", "b"] }],
  dateRange: { kind: "relative" as const, preset: "last-30-days" },
  granularity: "day" as const,
};

describe("saved view report config schema", () => {
  it("accepts a valid report create input", () => {
    const parsed = createInputSchema.safeParse({
      ...baseCreate,
      page: "report",
      config: validConfig,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts absolute and all date ranges", () => {
    for (const dateRange of [
      { kind: "all" },
      { kind: "absolute", from: "2026-09-01", to: "2026-09-15" },
    ]) {
      const parsed = createInputSchema.safeParse({
        ...baseCreate,
        page: "report",
        config: { ...validConfig, dateRange },
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("passes unknown display keys through untouched", () => {
    const parsed = createInputSchema.parse({
      ...baseCreate,
      page: "report",
      config: {
        ...validConfig,
        display: { chartType: "stacked-bar", series: "statusReason", futureKnob: true },
      },
    });
    expect(parsed.config).toMatchObject({
      display: { chartType: "stacked-bar", futureKnob: true },
    });
  });

  it("rejects a report config under another page", () => {
    const parsed = createInputSchema.safeParse({
      ...baseCreate,
      page: "shift-view",
      config: validConfig,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown definition versions", () => {
    const parsed = createInputSchema.safeParse({
      ...baseCreate,
      page: "report",
      config: { ...validConfig, v: 2 },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty measures and oversized arrays", () => {
    for (const config of [
      { ...validConfig, measures: [] },
      { ...validConfig, measures: Array.from({ length: 21 }, (_, i) => `m${i}`) },
      { ...validConfig, dimensions: Array.from({ length: 11 }, (_, i) => `d${i}`) },
      {
        ...validConfig,
        filters: Array.from({ length: 21 }, () => ({
          dimension: "station",
          op: "eq",
          value: "x",
        })),
      },
    ]) {
      const parsed = createInputSchema.safeParse({ ...baseCreate, page: "report", config });
      expect(parsed.success).toBe(false);
    }
  });

  it("rejects malformed dates and out-of-range limits", () => {
    for (const config of [
      { ...validConfig, dateRange: { kind: "absolute", from: "09/01/2026", to: "2026-09-15" } },
      { ...validConfig, limit: 0 },
      { ...validConfig, limit: 10001 },
      { ...validConfig, granularity: "minute" },
    ]) {
      const parsed = createInputSchema.safeParse({ ...baseCreate, page: "report", config });
      expect(parsed.success).toBe(false);
    }
  });

  it("allows a rename-only update without config", () => {
    const parsed = updateInputSchema.safeParse({
      id: VIEW_ID,
      page: "report",
      name: "Renamed",
    });
    expect(parsed.success).toBe(true);
  });

  it("re-validates config on update", () => {
    expect(
      updateInputSchema.safeParse({ id: VIEW_ID, page: "report", config: validConfig }).success,
    ).toBe(true);
    expect(
      updateInputSchema.safeParse({
        id: VIEW_ID,
        page: "report",
        config: { ...validConfig, measures: [] },
      }).success,
    ).toBe(false);
  });
});

describe("saved view board config schema", () => {
  const board = {
    v: 1 as const,
    question: "OEE by station yesterday, and what hurt it?",
    dateRange: { kind: "relative" as const, preset: "yesterday" },
    filters: [{ dimension: "workcenter", op: "eq" as const, value: "w1" }],
    tiles: [
      { id: "t1", kind: "text" as const, tone: "summary" as const, text: "Press 4 had the lowest OEE." },
      { id: "t2", kind: "figures" as const, title: "Plant", definition: { ...validConfig, fact: "stationKpis", measures: ["oee"], dimensions: [] } },
      {
        id: "t3",
        kind: "report" as const,
        title: "Downtime reasons",
        width: "half" as const,
        definition: { ...validConfig, segments: ["unplannedDown"], filters: [{ dimension: "downSeconds", op: "gt" as const, value: "60" }] },
      },
    ],
  };

  it("accepts a board with text, figures and report tiles", () => {
    const parsed = createInputSchema.safeParse({ ...baseCreate, page: "board", config: board });
    expect(parsed.success).toBe(true);
  });

  it("accepts every report filter operator, and none-valued ones", () => {
    const parsed = createInputSchema.safeParse({
      ...baseCreate,
      page: "report",
      config: { ...validConfig, filters: [{ dimension: "tool", op: "isNull" }] },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown tile kinds and too many tiles", () => {
    const badKind = { ...board, tiles: [{ id: "x", kind: "map", title: "?" }] };
    const tooMany = { ...board, tiles: Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, kind: "text", tone: "note", text: "." })) };
    for (const config of [badKind, tooMany]) {
      expect(createInputSchema.safeParse({ ...baseCreate, page: "board", config }).success).toBe(false);
    }
  });

  it("accepts a v1 board without filters, as the page saves it", () => {
    const { filters: _filters, ...noFilters } = board;
    expect(createInputSchema.safeParse({ ...baseCreate, page: "board", config: noFilters }).success).toBe(true);
  });

  it("accepts a v2 spec board and caps its size", () => {
    const spec = {
      root: "board",
      elements: {
        board: { type: "Stack", props: { direction: "column", gap: "lg" }, children: ["answer"] },
        answer: { type: "Callout", props: { tone: "info", text: "Hi" } },
      },
    };
    expect(
      createInputSchema.safeParse({ ...baseCreate, page: "board", config: { v: 2, title: "T", spec } }).success,
    ).toBe(true);
    const huge = Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`e${i}`, { type: "Text", props: {} }]));
    expect(
      createInputSchema.safeParse({ ...baseCreate, page: "board", config: { v: 2, spec: { root: "e0", elements: huge } } })
        .success,
    ).toBe(false);
  });

  it("lets a board update carry only a new name", () => {
    const parsed = updateInputSchema.safeParse({ id: VIEW_ID, page: "board", name: "Renamed" });
    expect(parsed.success).toBe(true);
  });
});
