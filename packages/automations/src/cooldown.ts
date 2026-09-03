/**
 * Where "when did this automation last fire for this scope" lives. The engine checks it before
 * running a matched automation that has a cooldown and records the fire afterwards. The default
 * is in-memory (tests, single process); an app supplies a shared store so several instances agree.
 */
export interface CooldownStore {
  lastFiredAt(automationId: string, scope: string): Promise<number | undefined>;
  markFired(automationId: string, scope: string, at: number): Promise<void>;
}

export function createMemoryCooldownStore(): CooldownStore {
  const fired = new Map<string, number>();
  return {
    async lastFiredAt(automationId, scope) {
      return fired.get(`${automationId}\u0000${scope}`);
    },
    async markFired(automationId, scope, at) {
      fired.set(`${automationId}\u0000${scope}`, at);
    },
  };
}
