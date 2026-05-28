import { Engine } from "json-rules-engine";
import { type ActionRegistry, missingRequired } from "./actions.js";
import type { ContextBuilder } from "./context.js";
import { interpolateInputs } from "./interpolate.js";
import { qbToEngineConditions } from "./qb-to-engine.js";
import type { AutomationStore } from "./store.js";
import type { AppEvent, Automation, EventType } from "./types.js";

export interface EngineDeps {
  store: AutomationStore;
  /** Per-event-type fact builders. Must cover every event type the framework will see. */
  contextBuilders: Record<EventType, ContextBuilder>;
  actions: ActionRegistry;
}

/**
 * Evaluates automations and runs their actions. The evaluation core (json-rules-engine + condition
 * translation) is shared by every event type; the engine is pluggable in two places:
 *   - SEAM A: how an event becomes facts             -> ContextBuilder (per event type)
 *   - SEAM C: what a matched automation's action does -> ActionRegistry
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

  /**
   * Run every action on the automation, in order. Throws on a missing handler version or missing
   * required input — these are misconfigurations and abort the dispatch loop loudly. Actions that
   * ran before a throw have already produced their side effects; subsequent actions don't run.
   *
   * Handler resolution is STRICT on `(type, version)`. Event-version dispatch is lenient: the
   * automation fires against whatever payload arrived (caller decided the event version at
   * fire-time via FireOptions.version or it defaulted to latest).
   */
  async function runActions(automation: Automation, event: AppEvent): Promise<void> {
    for (const [idx, action] of automation.actions.entries()) {
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
      if (!engine) return [];

      const builder = deps.contextBuilders[event.type];
      if (!builder) throw new Error(`no context builder registered for event type "${event.type}"`);
      const facts = await builder.build(event);
      const { results } = await engine.run(facts);

      const matched: string[] = [];
      for (const r of results) {
        const automationId = r.event?.type;
        const automation = automationId ? deps.store.get(automationId) : undefined;
        if (!automation) continue;
        matched.push(automation.id);
        await runActions(automation, event);
      }
      return matched;
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
  // NOTE: transition operators for telemetry (increments_up, changes_to, …) would be registered
  // here too, comparing current vs previous values placed in the fact map by a ContextBuilder.

  for (const a of automations) {
    engine.addRule({
      conditions: qbToEngineConditions(a.conditions) as never,
      event: { type: a.id },
      priority: 10,
    });
  }
  return engine;
}
