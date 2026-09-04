import type { AppEvent } from "./types.js";

/** A delayed action waiting for its `runAt`. One pending entry per (automation, action, scope). */
export interface ScheduledAction {
  automationId: string;
  actionIdx: number;
  /** Type of the action at `actionIdx` when armed; the entry is dropped if the automation was edited so it no longer matches. */
  actionType: string;
  /** The event's scope value; "" = per automation. */
  scope: string;
  /** Epoch ms. */
  runAt: number;
  /** Off = after delivery the key stays held (schedule() returns false) until cancel(). On = the key frees on delivery. */
  repeat: boolean;
  /** The event that matched, handed to the action when it runs. */
  event: AppEvent;
}

/**
 * Where armed delayed actions wait. The engine arms one when a matched automation's action has a
 * `delayMs`, cancels it when a later event for the same scope no longer matches, and receives each
 * due entry through the handler given to `start()`. The default is in-memory timers (tests, single
 * process); an app supplies a shared store so several instances see one pending set and each entry
 * is delivered to exactly one of them.
 */
export interface ScheduleStore {
  /** Arm unless (automationId, actionIdx, scope) is already pending or held. Returns whether it was inserted. */
  schedule(input: ScheduledAction): Promise<boolean>;
  /** Drop every pending or held action of the automation for this scope. */
  cancel(automationId: string, scope: string): Promise<void>;
  /** Deliver due entries to `handler` until the returned stop function is called. */
  start(handler: (entry: ScheduledAction) => Promise<void>): Promise<() => Promise<void>>;
}

export function createMemoryScheduleStore(): ScheduleStore {
  const pending = new Map<string, { entry: ScheduledAction; timer?: ReturnType<typeof setTimeout> }>();
  const key = (s: ScheduledAction) => `${s.automationId} ${s.actionIdx} ${s.scope}`;
  let deliver: ((entry: ScheduledAction) => Promise<void>) | undefined;
  return {
    async schedule(entry) {
      const k = key(entry);
      if (pending.has(k)) return false;
      const timer = setTimeout(
        () => {
          if (entry.repeat) pending.delete(k);
          else pending.set(k, { entry });
          void deliver?.(entry);
        },
        Math.max(0, entry.runAt - Date.now()),
      );
      pending.set(k, { entry, timer });
      return true;
    },
    async cancel(automationId, scope) {
      for (const [k, { entry, timer }] of pending) {
        if (entry.automationId === automationId && entry.scope === scope) {
          clearTimeout(timer);
          pending.delete(k);
        }
      }
    },
    async start(handler) {
      deliver = handler;
      return async () => {
        deliver = undefined;
        for (const { timer } of pending.values()) clearTimeout(timer);
        pending.clear();
      };
    },
  };
}
