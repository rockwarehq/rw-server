import { Engine } from "json-rules-engine";
import { type ActionRegistry, missingRequired } from "./actions.js";
import type { ContextBuilder } from "./context.js";
import { type CooldownStore, createMemoryCooldownStore } from "./cooldown.js";
import { interpolateInputs } from "./interpolate.js";
import { qbToEngineConditions } from "./qb-to-engine.js";
import { noopRunRecorder, type RunRecorder } from "./recorder.js";
import { createMemoryScheduleStore, type ScheduleStore } from "./schedule.js";
import type { AutomationStore } from "./store.js";
import type { AppEvent, Automation, AutomationAction, EventType } from "./types.js";

export interface EngineDeps {
  store: AutomationStore;
  /** Per-event-type fact builders. Must cover every event type the framework will see. */
  contextBuilders: Record<EventType, ContextBuilder>;
  actions: ActionRegistry;
  recorder?: RunRecorder;
  /** Events with `hop` above this are dropped (recorded, not evaluated). */
  maxHops: number;
  cooldowns?: CooldownStore;
  schedules?: ScheduleStore;
}

export interface DispatchResult {
  /** Ids of the automations whose conditions matched, in dispatch order. */
  matched: string[];
  /** Automations that matched but were still cooling down for the event's cooldown scope. */
  cooled: string[];
  /** Set when the event exceeded `maxHops` and was not evaluated. */
  dropped?: string;
}

/**
 * Evaluates automations and runs their actions. The evaluation core (json-rules-engine + condition
 * translation) is shared by every event type.
 *
 * Conditions are indexed per event type, so an automation only runs against events of its own type.
 * A partitioned automation additionally only runs against events of its own partition; a global one
 * (no partition) sees every event of its type.
 */
export interface AutomationEngine {
  /** Rebuild the per-event-type rule engines from the current enabled automations. */
  reload(): void;
  /** Run all conditions for this event's type; fire the action of each matching automation. */
  dispatch(event: AppEvent): Promise<DispatchResult>;
  /** Start receiving due delayed actions from the schedule store and running them. Returns a stop function. */
  startScheduled(): Promise<() => Promise<void>>;
}

const hasDelay = (action: AutomationAction) => (action.delayMs ?? 0) > 0;

export function createAutomationEngine(deps: EngineDeps): AutomationEngine {
  // Compiled engines, one per event type. Rebuilt by reload().
  let engines = new Map<EventType, Engine>();
  const recorder: RunRecorder = deps.recorder ?? noopRunRecorder;
  const cooldowns = deps.cooldowns ?? createMemoryCooldownStore();
  const schedules = deps.schedules ?? createMemoryScheduleStore();

  /** True when the automation fired for this event's cooldown scope less than `cooldownMs` ago. */
  async function coolingDown(automation: Automation, event: AppEvent): Promise<boolean> {
    const windowMs = automation.cooldownMs ?? 0;
    if (windowMs <= 0) return false;
    const last = await cooldowns.lastFiredAt(automation.id, event.cooldownScope ?? "");
    return last !== undefined && Date.parse(event.ts) - last < windowMs;
  }

  /** Enabled automations for this event's type and partition that were not in `matched`. */
  function unmatched(event: AppEvent, matched: Set<string>): Automation[] {
    return deps.store
      .list()
      .filter(
        (a) =>
          a.enabled &&
          a.event === event.type &&
          (a.partition == null || a.partition === event.partition) &&
          !matched.has(a.id),
      );
  }

  async function runAction(
    automation: Automation,
    action: AutomationAction,
    idx: number,
    event: AppEvent,
    runId: string,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const record = (status: "SUCCESS" | "FAILED", error?: string) =>
      recorder.recordAction({
        runId,
        automationId: automation.id,
        actionIdx: idx,
        actionType: action.type,
        actionVersion: action.version,
        status,
        error,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
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

      await versioned.run(inputs, { automation, event, eventId: event.id, actionIdx: idx });
      await record("SUCCESS");
    } catch (err) {
      await record("FAILED", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function runActions(automation: Automation, event: AppEvent, runId: string): Promise<void> {
    for (const [idx, action] of automation.actions.entries()) {
      if (!hasDelay(action)) {
        await runAction(automation, action, idx, event, runId);
        continue;
      }
      // Arm-if-absent: a repeat match for the same scope keeps the original clock. The delay counts
      // from `since` (when the condition began) when the schema provides it, else from the event;
      // an anchor already past the delay fires immediately.
      const now = Date.parse(event.ts);
      const runAt = Math.max(now, (event.since ? Date.parse(event.since) : now) + (action.delayMs ?? 0));
      const armed = await schedules.schedule({
        automationId: automation.id,
        actionIdx: idx,
        actionType: action.type,
        scope: event.scope ?? "",
        runAt,
        repeat: !!action.repeat,
        event,
      });
      const at = new Date().toISOString();
      await recorder.recordAction({
        runId,
        automationId: automation.id,
        actionIdx: idx,
        actionType: action.type,
        actionVersion: action.version,
        status: armed ? "SCHEDULED" : "SKIPPED",
        error: armed ? undefined : "already armed or fired for this scope",
        startedAt: at,
        finishedAt: at,
      });
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

    async dispatch(event: AppEvent): Promise<DispatchResult> {
      if (event.hop > deps.maxHops) {
        const dropped = `hop ${event.hop} exceeds maxHops ${deps.maxHops} (correlationId ${event.correlationId})`;
        const runId = await recorder.startRun({ event });
        await recorder.finishRun(runId, { matched: [], status: "DROPPED", error: dropped });
        return { matched: [], cooled: [], dropped };
      }

      const engine = engines.get(event.type);
      if (!engine) {
        const runId = await recorder.startRun({ event });
        await recorder.finishRun(runId, { matched: [], status: "SUCCESS" });
        return { matched: [], cooled: [] };
      }

      const builder = deps.contextBuilders[event.type];
      if (!builder) throw new Error(`no context builder registered for event type "${event.type}"`);

      const runId = await recorder.startRun({ event });
      const matched: string[] = [];
      const cooled: string[] = [];
      try {
        const facts = await builder.build(event);
        const { results } = await engine.run(facts);
        for (const r of results) {
          const automationId = r.event?.type;
          const automation = automationId ? deps.store.get(automationId) : undefined;
          if (!automation) continue;
          if (automation.partition != null && automation.partition !== event.partition) continue;
          if (await coolingDown(automation, event)) {
            cooled.push(automation.id);
            continue;
          }
          matched.push(automation.id);
          if ((automation.cooldownMs ?? 0) > 0) {
            await cooldowns.markFired(automation.id, event.cooldownScope ?? "", Date.parse(event.ts));
          }
          await runActions(automation, event, runId);
        }
        // Cancel-on-clear: the scope's condition no longer holds for these, so drop anything armed.
        for (const a of unmatched(event, new Set([...matched, ...cooled]))) {
          if (a.actions.some(hasDelay)) await schedules.cancel(a.id, event.scope ?? "");
        }
        await recorder.finishRun(runId, { matched, cooled, status: "SUCCESS" });
        return { matched, cooled };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recorder.finishRun(runId, { matched, cooled, status: "FAILED", error: message });
        throw err;
      }
    },

    startScheduled() {
      return schedules.start(async (s) => {
        // Runs the automation as it is now; an entry whose automation is gone or disabled, or whose
        // action was removed or replaced by one of another type, is dropped.
        const automation = deps.store.get(s.automationId);
        const action = automation?.enabled ? automation.actions[s.actionIdx] : undefined;
        if (!automation || action?.type !== s.actionType) return;
        const runId = await recorder.startRun({ event: s.event });
        try {
          await runAction(automation, action, s.actionIdx, s.event, runId);
          await recorder.finishRun(runId, { matched: [automation.id], status: "SUCCESS" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recorder.finishRun(runId, { matched: [automation.id], status: "FAILED", error: message });
        }
      });
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
