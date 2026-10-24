import { randomUUID } from "node:crypto";
import type { Automation, AutomationAction, AutomationStore, DailySchedule, RuleGroupType } from "@rw/automations";
import prisma, { Prisma } from "@rw/db";
import { auditRecord } from "../audit/index.js";

const AUDITED_FIELDS = [
  "label",
  "enabled",
  "event",
  "eventVersion",
  "cooldownMs",
  "conditions",
  "actions",
  "schedule",
] as const;

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
        schedule: automation.schedule ? { ...automation.schedule } : Prisma.DbNull,
      };
      const before = cache.get(automation.id);
      const row = await prisma.$transaction(async (tx) => {
        const written = await tx.automation.upsert({
          where: { id: automation.id },
          create: { id: automation.id, ...data },
          update: data,
        });
        await auditRecord(tx, {
          change: before ? "updated" : "created",
          entityType: "automation",
          entityId: written.id,
          siteId: written.siteId,
          label: written.label,
          before: before ? { ...before } : undefined,
          after: { ...rowToAutomation(written) },
          fields: AUDITED_FIELDS,
        });
        return written;
      });
      const out = rowToAutomation(row);
      cache.set(out.id, out);
      return out;
    },

    async remove(id) {
      // The cache + DB are kept consistent: if the DB delete fails (no row), the cache miss tells
      // the caller the same thing it'd see if it had just done a get() first.
      const existing = cache.get(id);
      if (!existing) return false;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.automation.delete({ where: { id } });
          await auditRecord(tx, {
            change: "deleted",
            entityType: "automation",
            entityId: id,
            siteId: existing.partition,
            label: existing.label,
            fields: [],
          });
        });
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
  schedule: unknown;
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
    schedule: row.schedule as DailySchedule | null,
  };
}
