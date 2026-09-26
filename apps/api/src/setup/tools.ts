import { call } from "@orpc/server";
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import type { RPCContext } from "../rpc/context.js";
import { inputJsonSchema, resolveAction } from "./catalog.js";
import { SETUP_DOMAINS } from "./manifest.js";
import { proposePlan } from "./plans.js";

// The setup assistant's tools, added to the Insights assistant (rpc/insights.ts).
// They are built per request around the person's own RPC context: reads run
// the real procedures as that person, and changes only ever become a plan the
// person must approve (plans.ts).

/** The stream event carrying a proposed plan to the page. */
export const PLAN_EVENT = "insights.plan";

/** How much of a read result the AI gets to see. */
const MAX_READ_CHARS = 12_000;

export const SETUP_INSTRUCTIONS = `
You can also help people set up and configure Rockware: the plant, workcenters, stations, shifts, products, jobs, reasons, calls, automations, displays, people and access, integrations and more.

How to set things up:
1. Call list_setup to see the areas and actions (or list_setup with a domain for its actions). Areas are listed in the order a plant is usually set up; mind "dependsOn".
2. Call describe_action for each action you plan to use, to get its exact inputs. Never guess field names.
3. Use read to look at what's there already (lists, gets) so you don't make duplicates and so you have real ids. For a new plant or "what's left to set up", call plant_checklist.
4. Call propose_plan with every change as steps. Nothing changes until the person presses Apply on the plan card. A step can use an earlier step's result: "$wc1" is the id step "wc1" made, "$wc1.name" another field.
5. After proposing, tell the person in a sentence what the plan does and to review it. Never say it's done until you get a message that it was applied.
6. After a plan is applied, show the result with the setup components (WorkcenterLayout, ShiftRotation, StationProfile, CallType, AndonRule, EntityCard) using show.

Setup rules:
- Ask before guessing anything that matters: names, numbers like speeds and shift times, who gets access. Suggest sensible defaults and say they are defaults.
- Keep plans focused; one plan per thing the person asked for.
- Steps marked dangerous (deletes, sending messages, access changes, credentials) are shown with a warning and need their own tick; say plainly what they will do.
- Some things can't be done here: uploading files and logos, pairing devices without the code on their screen, inviting new users. Say where to do them instead.
- If read or propose_plan says the person lacks access, tell them who can do it (a plant admin or account admin); don't try to work around it.
`;

function trim(result: unknown): unknown {
  // Lists come as arrays or { data, total }; keep the first 50 rows.
  let value = result;
  if (Array.isArray(value) && value.length > 50)
    value = { rows: value.slice(0, 50), note: `First 50 of ${value.length}.` };
  const data = (value as { data?: unknown })?.data;
  if (Array.isArray(data) && data.length > 50)
    value = { ...(value as object), data: data.slice(0, 50), note: `First 50 of ${data.length}.` };
  const text = JSON.stringify(value);
  return text.length > MAX_READ_CHARS
    ? { preview: text.slice(0, MAX_READ_CHARS), note: "Cut short; narrow the read (filters, limit)." }
    : value;
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const r = result as { data?: unknown; items?: unknown; rows?: unknown };
  for (const v of [r?.data, r?.items, r?.rows]) if (Array.isArray(v)) return v;
  return [];
}

function totalOf(result: unknown): number {
  const total = (result as { total?: unknown })?.total;
  return typeof total === "number" ? total : rowsOf(result).length;
}

export function setupTools(context: RPCContext, siteId: string) {
  const readAs = async (path: string, input: unknown) => {
    const action = await resolveAction(path);
    if (!action) throw new Error(`${path} isn't in the setup catalog.`);
    return call(action.proc, input, { context });
  };

  const listSetupTool = toolDefinition({
    name: "list_setup",
    description:
      "List what can be set up. With no domain: every area in setup order, with what it depends on. With a domain: its actions (reads, changes, deletes) and notes.",
    inputSchema: z.object({ domain: z.string().optional() }),
  }).server(async ({ domain }) => {
    if (domain) {
      const d = SETUP_DOMAINS[domain];
      if (!d) return { error: `No area ${domain}. Areas: ${Object.keys(SETUP_DOMAINS).join(", ")}.` };
      return {
        domain,
        ...d,
        actions: Object.entries(d.actions).map(([path, a]) => ({ path, ...a })),
      };
    }
    return Object.entries(SETUP_DOMAINS).map(([key, d]) => ({
      domain: key,
      label: d.label,
      description: d.description,
      ...(d.dependsOn ? { dependsOn: d.dependsOn } : {}),
    }));
  });

  const describeActionTool = toolDefinition({
    name: "describe_action",
    description: "Get one action's exact inputs (as JSON Schema), what it does, the access it needs, and any danger.",
    inputSchema: z.object({ path: z.string().describe("An action path from list_setup, like station.create") }),
  }).server(async ({ path }) => {
    const action = await resolveAction(path);
    if (!action) return { error: `${path} isn't a setup action. Use list_setup.` };
    const { proc: _proc, ...meta } = action;
    return { ...meta, notes: SETUP_DOMAINS[action.domain]?.notes, input: await inputJsonSchema(path) };
  });

  const readTool = toolDefinition({
    name: "read",
    description:
      "Run a read action (a list or get) as the person and see the result. Use it to find ids and to check what exists before planning changes. Most lists take siteId.",
    inputSchema: z.object({ path: z.string(), input: z.record(z.string(), z.unknown()).default({}) }),
  }).server(async ({ path, input }) => {
    const action = await resolveAction(path);
    if (!action) return { error: `${path} isn't a setup action. Use list_setup.` };
    if (action.kind !== "read") return { error: `${path} changes things; put it in a plan with propose_plan.` };
    try {
      return trim(await call(action.proc, input ?? {}, { context }));
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The read failed." };
    }
  });

  const checklistTool = toolDefinition({
    name: "plant_checklist",
    description:
      "Check how far this plant's setup has come: what's there, what's missing, and what to do next, in setup order.",
    inputSchema: z.object({}),
  }).server(async () => {
    const count = async (path: string, input: Record<string, unknown> = { siteId }) => {
      try {
        const result = await readAs(path, input);
        return { total: totalOf(result), rows: rowsOf(result) };
      } catch {
        return { total: -1, rows: [] as unknown[] };
      }
    };
    const [
      site,
      workcenters,
      stations,
      patterns,
      published,
      products,
      jobs,
      reasons,
      dispositions,
      calls,
      modes,
      employees,
      displays,
    ] = await Promise.all([
      readAs("site.get", { id: siteId }).catch(() => null),
      count("workcenter.list"),
      count("station.list", { siteId, limit: 500 }),
      count("shiftPattern.list"),
      count("shiftAssignment.list"),
      count("product.list"),
      count("job.list"),
      count("statusReason.list"),
      count("disposition.list"),
      count("callDefinition.list"),
      count("productionMode.list"),
      count("employee.list"),
      count("display.list", { siteId }),
    ]);
    const timezone = (site as { timezone?: string } | null)?.timezone;
    const looseStations = stations.rows.filter((s) => !(s as { workcenterId?: string | null }).workcenterId).length;
    const hasScrap = dispositions.rows.some((d) => (d as { isSystem?: boolean }).isSystem);
    const item = (label: string, done: boolean | null, detail: string, next?: string) => ({
      label,
      status: done === null ? "unknown" : done ? "done" : "todo",
      detail,
      ...(done === false && next ? { next } : {}),
    });
    const n = (c: { total: number }) => (c.total < 0 ? null : c.total);
    return {
      checklist: [
        item(
          "Time zone",
          timezone ? timezone !== "UTC" : null,
          timezone ? `Set to ${timezone}.` : "Unknown.",
          "Set the plant's time zone (site.update).",
        ),
        item(
          "Workcenters",
          n(workcenters) === null ? null : workcenters.total > 0,
          `${workcenters.total} workcenters.`,
          "Create the lines or areas.",
        ),
        item(
          "Stations",
          n(stations) === null ? null : stations.total > 0 && looseStations === 0,
          `${stations.total} stations${looseStations ? `, ${looseStations} not in a workcenter` : ""}.`,
          looseStations ? "Move stations into workcenters." : "Add stations to the workcenters.",
        ),
        item(
          "Shift schedule",
          n(published) === null ? null : published.total > 0,
          `${patterns.total} patterns, ${published.total} published.`,
          "Build a shift pattern and publish it.",
        ),
        item(
          "Products and jobs",
          n(jobs) === null ? null : products.total > 0 && jobs.total > 0,
          `${products.total} products, ${jobs.total} jobs.`,
          "Add products, then jobs that make them.",
        ),
        item(
          "Downtime reasons",
          n(reasons) === null ? null : reasons.total > 0,
          `${reasons.total} reasons.`,
          "Add downtime reasons, marking planned ones.",
        ),
        item(
          "Scrap disposition",
          n(dispositions) === null ? null : hasScrap,
          hasScrap ? "The system Scrap exists." : "No system Scrap yet.",
          "It is created on the next server deploy; scrap-all modes need it.",
        ),
        item(
          "Call types",
          n(calls) === null ? null : calls.total > 0,
          `${calls.total} call types.`,
          "Add call types like Maintenance and Quality.",
        ),
        item(
          "Production modes",
          n(modes) === null ? null : modes.total > 0,
          `${modes.total} modes.`,
          "Optional: add modes like Setup or Trial.",
        ),
        item(
          "Team",
          n(employees) === null ? null : employees.total > 0,
          `${employees.total} employees.`,
          "Add operators so they can log on.",
        ),
        item(
          "Terminals and boards",
          n(displays) === null ? null : displays.total > 0,
          `${displays.total} displays.`,
          "Pair terminals and boards with the code on their screens.",
        ),
      ],
    };
  });

  const stepSchema = z.object({
    id: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .describe("A short name later steps can refer to as $id"),
    action: z.string().describe("An action path, like workcenter.create"),
    input: z.record(z.string(), z.unknown()).describe("The action's input; describe_action shows the fields"),
    note: z.string().max(200).optional().describe("One plain line saying what this step does"),
  });

  const proposePlanTool = toolDefinition({
    name: "propose_plan",
    description:
      "Propose changes as a plan the person reviews and applies. Every change goes through here; nothing runs until they press Apply. Returns problems to fix if any step is wrong.",
    inputSchema: z.object({
      title: z.string().min(1).max(120).describe("What the plan does, like 'Set up Line 2 with 6 presses'"),
      steps: z.array(stepSchema).min(1).max(60),
    }),
  }).server(async ({ title, steps }, toolContext) => {
    const result = await proposePlan(context, siteId, title, steps);
    if ("problems" in result) return { problems: result.problems, hint: "Fix these and call propose_plan again." };
    const { plan } = result;
    toolContext?.emitCustomEvent(PLAN_EVENT, {
      plan: {
        id: plan.id,
        title: plan.title,
        steps: plan.steps.map((s) => ({
          id: s.id,
          action: s.action,
          kind: s.kind,
          summary: s.summary,
          note: s.note,
          input: s.input,
          ...(s.danger ? { danger: s.danger } : {}),
        })),
      },
    });
    return {
      planId: plan.id,
      steps: plan.steps.length,
      dangerous: plan.steps.filter((s) => s.danger).map((s) => s.id),
      next: "The person now sees the plan card. Tell them briefly what it does and to review and apply it. Don't say it's done.",
    };
  });

  return [listSetupTool, describeActionTool, readTool, checklistTool, proposePlanTool];
}
