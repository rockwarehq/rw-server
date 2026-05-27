import { Engine } from "json-rules-engine";
import { ActionRegistry, missingRequired } from "./actions.js";
import type { ContextBuilder } from "./context.js";
import { interpolateInputs } from "./interpolate.js";
import { qbToEngineConditions } from "./qb-to-engine.js";
import type { TriggerStore } from "./store.js";
import type { AppEvent, EventType, Notify, Trigger } from "./types.js";

export interface EngineDeps {
  store: TriggerStore;
  /** Per-event-type fact builders. */
  contextBuilders: Map<EventType, ContextBuilder>;
  /** Used when an event type has no registered builder. */
  defaultContextBuilder: ContextBuilder;
  actions: ActionRegistry;
}

/**
 * Evaluates triggers and runs their actions. The evaluation core (json-rules-engine + condition
 * translation) is shared by every event type; the engine is pluggable in two places:
 *   - SEAM A: how an event becomes facts        -> ContextBuilder (per event type)
 *   - SEAM C: what a matched trigger's action does -> ActionRegistry
 *
 * Conditions are indexed per event type, so a trigger only runs against events of its own type.
 */
export class TriggerEngine {
  private engines = new Map<EventType, Engine>();

  constructor(private readonly deps: EngineDeps) {}

  /** Rebuild the per-event-type rule engines from the current enabled triggers. */
  reload(): void {
    const byType = new Map<EventType, Trigger[]>();
    for (const t of this.deps.store.list()) {
      if (!t.enabled) continue;
      const list = byType.get(t.event) ?? [];
      list.push(t);
      byType.set(t.event, list);
    }

    this.engines = new Map();
    for (const [type, triggers] of byType) {
      this.engines.set(type, buildEngine(triggers));
    }
  }

  /** Run all conditions for this event's type; fire the action of each matching trigger. */
  async dispatch(event: AppEvent, notify: Notify): Promise<string[]> {
    notify({ type: "eventReceived", event });

    const engine = this.engines.get(event.type);
    if (!engine) return [];

    const builder = this.deps.contextBuilders.get(event.type) ?? this.deps.defaultContextBuilder;
    const facts = await builder.build(event);
    const { results } = await engine.run(facts);

    const matched: string[] = [];
    for (const r of results) {
      const triggerId = r.event?.type;
      const trigger = triggerId ? this.deps.store.get(triggerId) : undefined;
      if (!trigger) continue;
      matched.push(trigger.id);
      notify({ type: "triggerFired", triggerId: trigger.id, label: trigger.label, eventId: event.id });
      await this.runAction(trigger, event, notify);
    }
    return matched;
  }

  /** Resolve the action handler, interpolate {{...}} inputs, validate presence, then execute. */
  private async runAction(trigger: Trigger, event: AppEvent, notify: Notify): Promise<void> {
    const handler = this.deps.actions.get(trigger.action.type);
    if (!handler) {
      console.warn(`[triggers] skip ${trigger.label}: no handler for action "${trigger.action.type}"`);
      return;
    }

    const inputs = interpolateInputs(trigger.action.inputs as Record<string, unknown>, { event });
    const missing = missingRequired(inputs, handler.inputSchema);
    if (missing) {
      console.warn(`[triggers] skip ${trigger.label}: missing required input "${missing}"`);
      return;
    }

    await handler.run(inputs, { trigger, eventId: event.id, notify });
  }
}

/** Build a json-rules-engine instance for one event type's triggers. */
function buildEngine(triggers: Trigger[]): Engine {
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

  for (const t of triggers) {
    engine.addRule({
      conditions: qbToEngineConditions(t.conditions) as never,
      event: { type: t.id },
      priority: 10,
    });
  }
  return engine;
}
