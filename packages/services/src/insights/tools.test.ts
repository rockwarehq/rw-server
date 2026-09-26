import { describe, expect, it } from "vitest";
import { type Board, boardSchema, emptyBoard } from "./board.js";
import { stableInstructions, turnInstructions } from "./prompt.js";
import { insightsTools } from "./tools.js";

// The tools, run the way the chat runner runs them, without a database or an
// AI. Only update_board and the catalog tools are here; run_query and
// find_values read the database; they are checked against a real database
// by hand (docs/architecture/insights.md).

const scope = { siteId: "11111111-1111-4111-8111-111111111111" };

function setup(board: Board = emptyBoard()) {
  const seen: Board[] = [];
  const events: Array<{ name: string; value: unknown }> = [];
  const ctx = { scope, timezone: "UTC", nowMs: Date.UTC(2026, 8, 24, 12), board, onBoard: (b: Board) => seen.push(b) };
  const tools = Object.fromEntries(insightsTools(ctx).map((t) => [t.name, t]));
  const toolContext = {
    emitCustomEvent: (name: string, value: Record<string, unknown>) => events.push({ name, value }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: tools are called with loose input, like the AI would.
  const call = async (name: string, input: any) => (tools[name] as any).execute(input, toolContext);
  return { ctx, seen, events, call };
}

const oeeByStation = {
  view: "oee",
  measures: ["oee", "availability"],
  dimensions: ["station"],
  dateRange: { kind: "relative", preset: "yesterday" },
};

describe("update_board", () => {
  it("adds tiles, turns views into facts, and sends the board to the page", async () => {
    const { call, seen, events } = setup();
    const out = await call("update_board", {
      question: "OEE yesterday",
      upsert: [
        { tile: { kind: "text", tone: "summary", text: "Press 4 was lowest." } },
        { tile: { kind: "report", title: "OEE by station", query: oeeByStation, chartType: "bar" } },
      ],
    });
    expect(out.problems).toBeUndefined();
    expect(out.tiles).toHaveLength(2);
    const board = seen.at(-1);
    expect(boardSchema.safeParse(board).success).toBe(true);
    const report = board?.tiles[1];
    expect(report).toMatchObject({
      kind: "report",
      definition: { fact: "stationKpis", display: { chartType: "bar" } },
    });
    expect(events.at(-1)).toMatchObject({ name: "insights.board" });
  });

  it("replaces a tile by id and keeps the rest", async () => {
    const { call, seen } = setup();
    const first = await call("update_board", {
      upsert: [
        { tile: { kind: "text", tone: "summary", text: "One" } },
        { tile: { kind: "report", title: "OEE", query: oeeByStation } },
      ],
    });
    const reportId = first.tiles[1].id;
    await call("update_board", {
      upsert: [
        {
          id: reportId,
          tile: {
            kind: "report",
            title: "OEE weekly",
            query: { ...oeeByStation, dimensions: ["businessDate"], granularity: "week" },
          },
        },
      ],
    });
    const board = seen.at(-1);
    expect(board?.tiles).toHaveLength(2);
    expect(board?.tiles[1]).toMatchObject({ id: reportId, title: "OEE weekly", definition: { granularity: "week" } });
  });

  it("sends bad tiles back as problems instead of adding them", async () => {
    const { call, seen } = setup();
    const out = await call("update_board", {
      upsert: [
        { tile: { kind: "report", title: "Made up", query: { ...oeeByStation, measures: ["happiness"] } } },
        {
          tile: {
            kind: "report",
            title: "Resin",
            query: { view: "materials", measures: ["quantity"], dimensions: ["material"], dateRange: { kind: "all" } },
          },
        },
        { tile: { kind: "text", tone: "note", text: "Kept" } },
      ],
    });
    expect(out.problems).toHaveLength(2);
    expect(out.problems[0]).toContain("happiness");
    expect(out.problems[1]).toContain("unit");
    expect(seen.at(-1)?.tiles).toHaveLength(1);
  });

  it("clears and removes", async () => {
    const { call, seen } = setup();
    const out = await call("update_board", {
      upsert: [
        { tile: { kind: "text", tone: "note", text: "a" } },
        { tile: { kind: "text", tone: "note", text: "b" } },
      ],
    });
    await call("update_board", { remove: [out.tiles[0].id] });
    expect(seen.at(-1)?.tiles.map((t) => (t.kind === "text" ? t.text : ""))).toEqual(["b"]);
    await call("update_board", { clear: true, upsert: [{ tile: { kind: "text", tone: "note", text: "c" } }] });
    expect(seen.at(-1)?.tiles).toHaveLength(1);
  });
});

describe("catalog tools", () => {
  it("describe_view explains a view and refuses unknown ones", async () => {
    const { call } = setup();
    expect((await call("describe_view", { view: "downtime" })).segments.map((s: { key: string }) => s.key)).toContain(
      "unplannedDown",
    );
    expect(await call("describe_view", { view: "nope" })).toMatchObject({ error: expect.any(String) });
  });

  it("search_catalog finds views by everyday words", async () => {
    const { call } = setup();
    const { hits } = await call("search_catalog", { text: "mold scrap" });
    expect(hits.map((h: { view: string }) => h.view)).toContain("scrap");
  });

  it("find_values lists enum values without the database", async () => {
    const { call } = setup();
    const out = await call("find_values", { view: "downtime", dimension: "state" });
    expect(out.values.map((v: { id: string }) => v.id)).toEqual(["UP", "DOWN"]);
  });
});

describe("instructions", () => {
  it("keep the cached part free of dates and SQL", () => {
    const text = stableInstructions();
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text).not.toMatch(/SELECT|f\."/);
  });

  it("tell the AI today's date in the plant's time zone", () => {
    const text = turnInstructions({
      timezone: "America/Chicago",
      nowMs: Date.UTC(2026, 8, 25, 1),
      board: emptyBoard(),
    });
    expect(text).toContain("Thursday 2026-09-24");
    expect(text).toContain("empty");
  });
});
