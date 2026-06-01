import { Engine } from "json-rules-engine";
import { type ActionRegistry, missingRequired } from "./actions.js";
import type { ContextBuilder } from "./context.js";
import { interpolateInputs } from "./interpolate.js";
import { qbToEngineConditions } from "./qb-to-engine.js";
import { noopRunRecorder, type RunRecorder } from "./recorder.js";
import type { AutomationStore } from "./store.js";
import type { AppEvent, Automation, EventType } from "./types.js";

export interface EngineDeps {
  store: AutomationStore;
  /** Per-event-type fact builders. Must cover every event type the framework will see. */
  contextBuilders: Record<EventType, ContextBuilder>;
  actions: ActionRegistry;
  recorder?: RunRecorder;
}

/**
 * Evaluates automations and runs their actions. The evaluation core (json-rules-engine + condition
 * translation) is shared by every event type;
 *
 * Conditions are indexed per event type, so an automation only runs against events of its own type.
 */
export interface AutomationEngine {
  /** Rebuild the per-event-type rule engines from the current enabled automations. */
  reload(): void;
  /** Run all conditions for this event's type; fire the action of each matching automation. */
  dispatch(event: AppEvent): Promise<string[]>;
}

export function createAutomationEngine(deps: EngineDeps): AutomationEngine {
  // Compiled engines, one per event type. Rebuilt by reload().
  let engines = new Map<EventType, Engine>();
  const recorder: RunRecorder = deps.recorder ?? noopRunRecorder;

  async function runActions(automation: Automation, event: AppEvent, runId: string): Promise<void> {
    for (const [idx, action] of automation.actions.entries()) {
      const startedAt = new Date().toISOString();
      try {
        const versioned = deps.actions.get(action.type, action.version);
        if (!versioned) {
          const knownVersions = deps.actions.latest(action.type)
            ? ` (registered versions of "${action.type}" don't include "${action.version}")`
            : "";
          throw new Error(
            `automation "${automation.label}" (${automation.id}) action #${idx} ("${action.type}@${action.version}"): no handler registered${knownVersions}`,
          );
        }

        const inputs = interpolateInputs(action.inputs as Record<string, unknown>, { event });
        const missing = missingRequired(inputs, versioned.inputSchema);
        if (missing) {
          throw new Error(
            `automation "${automation.label}" (${automation.id}) action #${idx} ("${action.type}@${action.version}"): missing required input "${missing}"`,
          );
        }

        await versioned.run(inputs, { automation, eventId: event.id });
        await recorder.recordAction({
          runId,
          automationId: automation.id,
          actionIdx: idx,
          actionType: action.type,
          actionVersion: action.version,
          status: "SUCCESS",
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recorder.recordAction({
          runId,
          automationId: automation.id,
          actionIdx: idx,
          actionType: action.type,
          actionVersion: action.version,
          status: "FAILED",
          error: message,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        throw err;
      }
    }
  }

  return {
    reload(): void {
      const byType = new Map<EventType, Automation[]>();
      for (const a of deps.store.list()) {
        if (!a.enabled) continue;
        const list = byType.get(a.event) ?? [];
        list.push(a);
        byType.set(a.event, list);
      }

      engines = new Map();
      for (const [type, automations] of byType) {
        engines.set(type, buildEngine(automations));
      }
    },

    async dispatch(event: AppEvent): Promise<string[]> {
      const engine = engines.get(event.type);
      if (!engine) {
        const runId = await recorder.startRun({ event });
        await recorder.finishRun(runId, { matched: [], status: "SUCCESS" });
        return [];
      }

      const builder = deps.contextBuilders[event.type];
      if (!builder) throw new Error(`no context builder registered for event type "${event.type}"`);

      const runId = await recorder.startRun({ event });
      const matched: string[] = [];
      try {
        const facts = await builder.build(event);
        const { results } = await engine.run(facts);

        for (const r of results) {
          const automationId = r.event?.type;
          const automation = automationId ? deps.store.get(automationId) : undefined;
          if (!automation) continue;
          matched.push(automation.id);
          await runActions(automation, event, runId);
        }
        await recorder.finishRun(runId, { matched, status: "SUCCESS" });
        return matched;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recorder.finishRun(runId, { matched, status: "FAILED", error: message });
        throw err;
      }
    },
  };
}

/** Build a json-rules-engine instance for one event type's automations. */
function buildEngine(automations: Automation[]): Engine {
  const engine = new Engine([], { allowUndefinedFacts: true });

  // String operators that the query builder exposes but json-rules-engine lacks.
  engine.addOperator(
    "stringContains",
    (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.includes(b),
  );
  engine.addOperator(
    "stringStartsWith",
    (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.startsWith(b),
  );
  engine.addOperator(
    "stringEndsWith",
    (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.endsWith(b),
  );

  for (const a of automations) {
    engine.addRule({
      conditions: qbToEngineConditions(a.conditions) as never,
      event: { type: a.id },
      priority: 10,
    });
  }
  return engine;
}
