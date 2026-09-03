import { randomUUID } from "node:crypto";
import type { Automation, AutomationAction, AutomationStore, RuleGroupType } from "@rw/automations";
import prisma from "@rw/db";

/**
 * Prisma-backed implementation of @rw/automations' `AutomationStore`.
 *
 * Initial load fills an in-memory `Map` so `list()` / `get()` stay synchronous (the engine's hot
 * path expects sync reads). Writes go to Postgres AND update the cache in lockstep.
 *
 * The engine's `partition` is the row's `siteId` (null = global, legacy rows only).
 *
 * MULTI-INSTANCE CAVEAT: another instance writing won't refresh THIS instance's cache. Plan
 * documented in @rw/automations' `store.ts` — Redis pub/sub broadcast. Single-instance for now.
 */
export async function createDbAutomationStore(): Promise<AutomationStore> {
  const rows = await prisma.automation.findMany();
  const cache = new Map<string, Automation>(rows.map((r) => [r.id, rowToAutomation(r)]));

  return {
    list: () => [...cache.values()],
    get: (id) => cache.get(id),

    async upsert(automation) {
      const data = {
        label: automation.label,
        enabled: automation.enabled,
        event: automation.event,
        eventVersion: automation.eventVersion,
        siteId: automation.partition ?? null,
        cooldownMs: automation.cooldownMs ?? null,
        // JSON columns; Prisma serializes structured values directly.
        conditions: automation.conditions as unknown as Parameters<
          typeof prisma.automation.upsert
        >[0]["update"]["conditions"],
        actions: automation.actions as unknown as Parameters<typeof prisma.automation.upsert>[0]["update"]["actions"],
      };
      const row = await prisma.automation.upsert({
        where: { id: automation.id },
        create: { id: automation.id, ...data },
        update: data,
      });
      const out = rowToAutomation(row);
      cache.set(out.id, out);
      return out;
    },

    async remove(id) {
      // The cache + DB are kept consistent: if the DB delete fails (no row), the cache miss tells
      // the caller the same thing it'd see if it had just done a get() first.
      if (!cache.has(id)) return false;
      try {
        await prisma.automation.delete({ where: { id } });
      } catch {
        // Row was already gone (race) — proceed to clear cache below.
      }
      cache.delete(id);
      return true;
    },

    // `Automation.id` is `@db.Uuid` (as are the audit `automationId` / `eventId` columns), so ids
    // must be UUIDs — same format `fire()` uses for event ids.
    newId: () => randomUUID(),
  };
}

/** Turn a Prisma row into the in-memory `Automation` the engine expects. */
function rowToAutomation(row: {
  id: string;
  label: string;
  enabled: boolean;
  event: string;
  eventVersion: string;
  siteId: string | null;
  cooldownMs: number | null;
  conditions: unknown;
  actions: unknown;
}): Automation {
  return {
    id: row.id,
    label: row.label,
    enabled: row.enabled,
    event: row.event,
    eventVersion: row.eventVersion,
    partition: row.siteId,
    cooldownMs: row.cooldownMs,
    conditions: row.conditions as RuleGroupType,
    actions: row.actions as AutomationAction[],
  };
}
