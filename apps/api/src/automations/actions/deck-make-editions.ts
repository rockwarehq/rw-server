import type { ActionHandler } from "@rw/automations";
import * as deck from "@rw/services/deck/index";
import prisma from "@rw/db";
import { unwrapService } from "./shared.js";

export const DECKS_INPUT = {
  type: "array" as const,
  items: { type: "string" as const },
  title: "Decks",
  ref: { source: "decks", multi: true },
};

export const ids = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

/** The event's planned moment (a clock trigger's `scheduledAt`), so a late run still covers the right days. */
const plannedAt = (payload: Record<string, unknown>) => {
  const at = typeof payload.scheduledAt === "string" ? new Date(payload.scheduledAt) : null;
  return at && !Number.isNaN(at.getTime()) ? at : new Date();
};

/** The automation's own site's decks among `deckIds`; any other (or deleted) is left out. */
export async function siteDecks(deckIds: string[], siteId: string) {
  const rows = await prisma.reportDeck.findMany({
    where: { id: { in: deckIds }, siteId },
    select: { id: true, name: true },
  });
  return deckIds.flatMap((id) => rows.filter((row) => row.id === id));
}

export const handler: ActionHandler = {
  type: "deck.makeEditions",
  displayName: "Make deck editions",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["deckIds"],
        properties: {
          deckIds: { ...DECKS_INPUT, description: "Each deck's days are worked out as of the scheduled time." },
        },
      },
      async run(inputs, ctx) {
        const siteId = ctx.event.partition;
        if (!siteId) throw new Error(`automation "${ctx.automation.label}": no site to make editions for`);
        const asOf = plannedAt(ctx.event.payload);
        for (const { id } of await siteDecks(ids(inputs.deckIds), siteId)) {
          // A redelivered tick finds the edition it already made.
          const made = await prisma.reportDeckEdition.findFirst({
            where: { deckId: id, automationId: ctx.automation.id, asOf },
            select: { id: true },
          });
          if (made) continue;
          unwrapService(await deck.makeEdition(id, { asOf, source: "SCHEDULE", automationId: ctx.automation.id }));
        }
      },
    },
  },
};
