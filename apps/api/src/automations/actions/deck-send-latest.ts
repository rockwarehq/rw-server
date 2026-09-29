import type { ActionHandler } from "@rw/automations";
import * as deck from "@rw/services/deck/index";
import * as notification from "@rw/services/notification/index";
import { getAppBaseUrl } from "@rw/runtime/email";
import { DECKS_INPUT, ids, siteDecks } from "./deck-make-editions.js";
import { systemSource, unwrapService } from "./shared.js";

const fill = (template: string, decks: string) => template.split("{{decks}}").join(decks);

export const handler: ActionHandler = {
  type: "deck.sendLatest",
  displayName: "Send the latest deck editions",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["deckIds", "subject", "body"],
        properties: {
          deckIds: {
            ...DECKS_INPUT,
            description: "The latest edition of each, new or not; a deck with none is left out.",
          },
          groupIds: {
            type: "array",
            items: { type: "string" },
            title: "Groups",
            description: "Every member of each group.",
            ref: { source: "notificationGroups", multi: true },
          },
          employeeIds: {
            type: "array",
            items: { type: "string" },
            title: "People",
            description: "Specific employees. Pick groups, people, or both.",
            ref: { source: "employees", multi: true },
          },
          subject: { type: "string", title: "Subject", description: "Supports {{decks}}." },
          body: {
            type: "string",
            title: "Message",
            description: "Supports {{decks}}. Each deck's name and link follow it, a line each.",
          },
          linkExpiryHours: {
            type: "number",
            title: "Link expires after (hours)",
            description: "Absent: the link lasts until it is revoked.",
          },
          links: {
            type: "string",
            enum: ["each", "one"],
            title: "Links",
            description: "each (default): a link per deck; one: one link for all of them.",
          },
        },
      },
      async run(inputs, ctx) {
        const groupIds = ids(inputs.groupIds);
        const employeeIds = ids(inputs.employeeIds);
        if (groupIds.length === 0 && employeeIds.length === 0) {
          throw new Error(`automation "${ctx.automation.label}": sending needs at least one group or person`);
        }
        const siteId = ctx.event.partition;
        if (!siteId) throw new Error(`automation "${ctx.automation.label}": no site to send from`);

        const decks = await siteDecks(ids(inputs.deckIds), siteId);
        const latest = (
          await Promise.all(
            decks.map(async (row) => ({
              name: row.name,
              edition: await deck.latestEdition(row.id),
            })),
          )
        ).flatMap(({ name, edition }) => (edition ? [{ name, editionId: edition.id }] : []));
        if (latest.length === 0) return;

        const hours = typeof inputs.linkExpiryHours === "number" ? inputs.linkExpiryHours : null;
        const expiresAt = hours && hours > 0 ? new Date(Date.now() + hours * 3_600_000) : null;
        const groups = inputs.links === "one" ? [latest] : latest.map((item) => [item]);
        const links: string[] = [];
        for (const group of groups) {
          const label = group.map((item) => item.name).join(" + ");
          const created = await deck.createLink({
            siteId,
            editionIds: group.map((item) => item.editionId),
            label,
            expiresAt,
            automationId: ctx.automation.id,
          });
          const { token } = unwrapService(created).data;
          links.push(`${label}: ${getAppBaseUrl()}/decks/${token}`);
        }

        const names = latest.map((item) => item.name).join(" + ");
        unwrapService(
          await notification.send({
            groupIds,
            employeeIds,
            channels: ["EMAIL"],
            siteId,
            subject: fill(String(inputs.subject), names),
            body: [fill(String(inputs.body), names).trimEnd(), ...links].join("\n"),
            // Stable across a redelivered event, so no double send.
            dedupeKey: `${ctx.event.id}:${ctx.automation.id}:${ctx.actionIdx}`,
            ...systemSource(ctx),
          }),
        );
      },
    },
  },
};
