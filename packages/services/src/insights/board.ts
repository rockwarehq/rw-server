import { z } from "zod";
import { checkTree, type Spec, storedSpecSchema } from "./components.js";
import { reportDefinitionSchema } from "./definition.js";

// An Insights board: a screen the AI built, saved as savedView page "board".
//
// v2 (now): a json-render spec of catalog components (see components.ts).
// v1 (first cut): a flat list of tiles. Still read, and turned into a spec.
//
// rw-ui apps/rw-imm/src/insights/board.ts must stay the same as this file.

export const boardSchema = z.object({
  v: z.literal(2),
  title: z.string().max(200).optional(),
  spec: storedSpecSchema,
});
export type Board = z.infer<typeof boardSchema>;

export const BOARD_ROOT = "board";

export const emptyBoard = (): Board => ({
  v: 2,
  spec: {
    root: BOARD_ROOT,
    elements: { [BOARD_ROOT]: { type: "Stack", props: { direction: "column", gap: "lg" }, children: [] } },
  },
});

/** Whether the board has anything to show under its root. */
export function boardHasContent(board: Board): boolean {
  const root = board.spec.elements[board.spec.root];
  return root !== undefined && (root.children?.length ?? 1) > 0;
}

// ── v1 ────────────────────────────────────────────────────────────────────────

const v1TileSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("report"), title: z.string(), definition: reportDefinitionSchema }),
  z.object({ id: z.string(), kind: z.literal("figures"), title: z.string(), definition: reportDefinitionSchema }),
  z.object({ id: z.string(), kind: z.literal("text"), tone: z.enum(["summary", "note", "caveat"]), text: z.string() }),
]);
const v1BoardSchema = z.object({
  v: z.literal(1),
  question: z.string().optional(),
  tiles: z.array(v1TileSchema),
});

/** Turn a v1 tile board into a spec board: a column of the same things. */
export function v1ToBoard(v1: z.infer<typeof v1BoardSchema>): Board {
  const board = emptyBoard();
  const elements: Spec["elements"] = { ...board.spec.elements };
  const children: string[] = [];
  for (const tile of v1.tiles) {
    const id = tile.id.replace(/[^a-zA-Z0-9_-]/g, "-");
    children.push(id);
    if (tile.kind === "text") {
      elements[id] =
        tile.tone === "summary"
          ? { type: "Text", props: { text: tile.text, variant: "reading" } }
          : { type: "Callout", props: { tone: tile.tone === "caveat" ? "caveat" : "info", text: tile.text } };
    } else if (tile.kind === "figures") {
      elements[id] = { type: "Figures", props: { title: tile.title, definition: tile.definition } };
    } else {
      elements[id] = {
        type: "Report",
        props: { title: tile.title, chart: tile.definition.display?.chartType ?? "bar", definition: tile.definition },
      };
    }
  }
  elements[BOARD_ROOT] = { ...elements[BOARD_ROOT]!, children };
  return { v: 2, ...(v1.question ? { title: v1.question } : {}), spec: { root: BOARD_ROOT, elements } };
}

/** A board from anywhere (the page, a saved view): v2 as is, v1 converted, else null. */
export function parseBoard(raw: unknown): Board | null {
  const v2 = boardSchema.safeParse(raw);
  // A board from outside may still loop or point at nothing; keep the safe copy.
  if (v2.success) return { ...v2.data, spec: checkTree(v2.data.spec).spec };
  const v1 = v1BoardSchema.safeParse(raw);
  return v1.success ? v1ToBoard(v1.data) : null;
}
