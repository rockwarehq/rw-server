import type { CooldownStore } from "@rw/automations";
import prisma from "@rw/db";

/** Prisma-backed `CooldownStore`: one row per (automation, scope), shared by every api instance. */
export function createDbCooldownStore(): CooldownStore {
  return {
    async lastFiredAt(automationId, scope) {
      const row = await prisma.automationCooldown.findUnique({
        where: { automationId_scope: { automationId, scope } },
        select: { firedAt: true },
      });
      return row?.firedAt.getTime();
    },
    async markFired(automationId, scope, at) {
      const firedAt = new Date(at);
      await prisma.automationCooldown.upsert({
        where: { automationId_scope: { automationId, scope } },
        create: { automationId, scope, firedAt },
        update: { firedAt },
      });
    },
  };
}
