import { describe, expect, it } from "vitest";
import { type Board, BOARD_ROOT, boardHasContent, boardSchema, emptyBoard, parseBoard } from "./board.js";
import { COMPONENT_TYPES } from "./components.js";
import { stableInstructions, turnInstructions } from "./prompt.js";
import { insightsTools } from "./tools.js";

// The tools, run the way the chat runner runs them, without a database or an
// AI. Only show, update_board and the catalog tools are here; run_query and
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

const oeeTotals = { ...oeeByStation, dimensions: [] };

describe("update_board", () => {
  it("adds elements, turns view queries into definitions, and sends the board", async () => {
    const { call, seen, events } = setup();
    const out = await call("update_board", {
      title: "OEE yesterday",
      set: [
        { id: "answer", type: "Callout", props: { tone: "bad", text: "Press 4 was lowest." } },
        { id: "headline", type: "Grid", props: { columns: 2 }, children: ["oee", "avail"] },
        { id: "oee", type: "Figure", props: { query: oeeTotals, measure: "oee" } },
        { id: "avail", type: "Figure", props: { query: oeeTotals, measure: "availability", label: "Uptime" } },
        { id: "by-station", type: "Report", props: { title: "OEE by station", query: oeeByStation, chart: "bar" } },
        { id: BOARD_ROOT, type: "Stack", props: {}, children: ["answer", "headline", "by-station"] },
      ],
    });
    expect(out.problems).toBeUndefined();
    const board = seen.at(-1)!;
    expect(boardSchema.safeParse(board).success).toBe(true);
    expect(board.title).toBe("OEE yesterday");
    expect(board.spec.elements["by-station"]).toMatchObject({
      type: "Report",
      props: { chart: "bar", definition: { fact: "stationKpis", display: { chartType: "bar" } } },
    });
    expect(board.spec.elements.oee?.props).not.toHaveProperty("query");
    expect(events.at(-1)).toMatchObject({ name: "insights.board" });
    expect(out.board.join("\n")).toContain('by-station: Report "OEE by station"');
  });

  it("changes one element by id and keeps the rest", async () => {
    const { call, seen } = setup();
    await call("update_board", {
      set: [
        { id: "chart", type: "Report", props: { query: oeeByStation } },
        { id: BOARD_ROOT, type: "Stack", props: {}, children: ["chart"] },
      ],
    });
    await call("update_board", {
      set: [
        {
          id: "chart",
          type: "Report",
          props: { query: { ...oeeByStation, dimensions: ["businessDate"], granularity: "week" }, chart: "line" },
        },
      ],
    });
    const board = seen.at(-1)!;
    expect(board.spec.elements[BOARD_ROOT]?.children).toEqual(["chart"]);
    expect(board.spec.elements.chart?.props).toMatchObject({ chart: "line", definition: { granularity: "week" } });
  });

  it("sends bad elements back as problems and keeps the good ones", async () => {
    const { call, seen } = setup();
    const out = await call("update_board", {
      set: [
        { id: "made-up", type: "Report", props: { query: { ...oeeByStation, measures: ["happiness"] } } },
        {
          id: "resin",
          type: "Report",
          props: {
            query: { view: "materials", measures: ["quantity"], dimensions: ["material"], dateRange: { kind: "all" } },
          },
        },
        { id: "grouped-figure", type: "Figure", props: { query: oeeByStation, measure: "oee" } },
        { id: "wrong-measure", type: "Figure", props: { query: oeeTotals, measure: "quality" } },
        { id: "gauge", type: "Gauge", props: {} },
        { id: "kept", type: "Text", props: { text: "Kept" } },
        { id: BOARD_ROOT, type: "Stack", props: {}, children: ["made-up", "kept"] },
      ],
    });
    const problems: string = out.problems.join("\n");
    expect(problems).toContain("happiness");
    expect(problems).toContain("unit");
    expect(problems).toContain("no dimensions");
    expect(problems).toContain("quality");
    expect(problems).toContain("Gauge");
    expect(problems).toContain("made-up that doesn't exist");
    const board = seen.at(-1)!;
    expect(board.spec.elements[BOARD_ROOT]?.children).toEqual(["kept"]);
    expect(Object.keys(board.spec.elements).sort()).toEqual([BOARD_ROOT, "kept"]);
  });

  it("refuses loops and drops elements nothing points at", async () => {
    const { call, seen } = setup();
    const out = await call("update_board", {
      set: [
        { id: "a", type: "Card", props: {}, children: ["b"] },
        { id: "b", type: "Card", props: {}, children: ["a"] },
        { id: "stray", type: "Text", props: { text: "nobody points here" } },
        { id: BOARD_ROOT, type: "Stack", props: {}, children: ["a"] },
      ],
    });
    expect(out.problems.join(" ")).toContain("contains itself");
    expect(seen.at(-1)!.spec.elements.stray).toBeUndefined();
  });

  it("removes and clears, but never the root", async () => {
    const { call, seen } = setup();
    await call("update_board", {
      set: [
        { id: "a", type: "Text", props: { text: "a" } },
        { id: "b", type: "Text", props: { text: "b" } },
        { id: BOARD_ROOT, type: "Stack", props: {}, children: ["a", "b"] },
      ],
    });
    await call("update_board", { remove: ["a"] });
    expect(seen.at(-1)!.spec.elements[BOARD_ROOT]?.children).toEqual(["b"]);
    const out = await call("update_board", { remove: [BOARD_ROOT] });
    expect(out.problems[0]).toContain("can't be removed");
    await call("update_board", { clear: true });
    expect(boardHasContent(seen.at(-1)!)).toBe(false);
  });
});

describe("show", () => {
  it("sends a small checked screen to the answer, with its own ids, and leaves the board alone", async () => {
    const { call, seen, events } = setup();
    const out = await call("show", {
      root: "row",
      elements: [
        { id: "row", type: "Grid", props: { columns: 2 }, children: ["oee", "strip"] },
        { id: "oee", type: "Figure", props: { query: oeeTotals, measure: "oee" } },
        {
          id: "strip",
          type: "StatusStrip",
          props: {
            query: {
              view: "downtime",
              measures: ["durationSeconds"],
              dimensions: ["state"],
              dateRange: { kind: "relative", preset: "yesterday" },
            },
            dimension: "state",
            measure: "durationSeconds",
          },
        },
      ],
    });
    expect(out.problems).toBeUndefined();
    const spec = (events.at(-1)?.value as { spec: { root: string; elements: Record<string, unknown> } }).spec;
    expect(events.at(-1)?.name).toBe("insights.inline");
    expect(spec.root).toMatch(/^inline.*-row$/);
    expect(Object.keys(spec.elements)).toHaveLength(3);
    expect(seen).toHaveLength(0);
  });

  it("sends a bad screen back to the AI instead of showing it", async () => {
    const { call, events } = setup();
    const out = await call("show", {
      root: "x",
      elements: [{ id: "x", type: "Report", props: { query: { ...oeeByStation, view: "nope" } } }],
    });
    expect(out.problems.join(" ")).toContain("nope");
    expect(events).toHaveLength(0);
  });

  it("refuses a status strip on a dimension that isn't a status", async () => {
    const { call } = setup();
    const out = await call("show", {
      root: "s",
      elements: [
        {
          id: "s",
          type: "StatusStrip",
          props: { query: { ...oeeByStation, measures: ["runSeconds"] }, dimension: "station", measure: "runSeconds" },
        },
      ],
    });
    expect(out.problems.join(" ")).toContain("status-like");
  });
});

describe("boards", () => {
  it("turns an old tile board into a spec board", () => {
    const board = parseBoard({
      v: 1,
      question: "OEE",
      tiles: [
        { id: "t1", kind: "text", tone: "summary", text: "Answer" },
        { id: "t2", kind: "text", tone: "caveat", text: "Careful" },
        {
          id: "t3",
          kind: "report",
          title: "By station",
          definition: {
            v: 1,
            fact: "stationKpis",
            measures: ["oee"],
            dimensions: ["station"],
            filters: [],
            dateRange: { kind: "all" },
            display: { chartType: "line" },
          },
        },
      ],
    });
    expect(board?.title).toBe("OEE");
    expect(board?.spec.elements[BOARD_ROOT]?.children).toEqual(["t1", "t2", "t3"]);
    expect(board?.spec.elements.t2).toMatchObject({ type: "Callout", props: { tone: "caveat" } });
    expect(board?.spec.elements.t3).toMatchObject({ type: "Report", props: { chart: "line" } });
    expect(parseBoard({ v: 9 })).toBeNull();
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

  it("list every component from the catalog", () => {
    const text = stableInstructions();
    for (const type of COMPONENT_TYPES) expect(text).toContain(`- ${type}`);
    expect(text).not.toContain("{{COMPONENTS}}");
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
