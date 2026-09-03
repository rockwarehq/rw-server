import type { ActionHandler } from "@rw/automations";
import * as notification from "@rw/services/notification/index";
import { systemSource, unwrapService } from "./shared.js";

const ids = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

export const handler: ActionHandler = {
  type: "notify",
  displayName: "Notify",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["subject", "body"],
        properties: {
          groupIds: {
            type: "array",
            items: { type: "string" },
            title: "Groups",
            description: "Every member of each group. Channels come from the group.",
            ref: { source: "notificationGroups", multi: true },
          },
          employeeIds: {
            type: "array",
            items: { type: "string" },
            title: "People",
            description: "Specific employees, by email. Pick groups, people, or both.",
            ref: { source: "employees", multi: true },
          },
          subject: { type: "string", title: "Subject", description: "Supports {{event.payload.*}} variables." },
          body: { type: "string", title: "Message", description: "Supports {{event.payload.*}} variables." },
        },
      },
      async run(inputs, ctx) {
        const groupIds = ids(inputs.groupIds);
        const employeeIds = ids(inputs.employeeIds);
        if (groupIds.length === 0 && employeeIds.length === 0) {
          throw new Error(`automation "${ctx.automation.label}": notify needs at least one group or person`);
        }
        unwrapService(
          await notification.send({
            groupIds,
            employeeIds,
            siteId: ctx.event.partition,
            subject: String(inputs.subject),
            body: String(inputs.body),
            // Stable across a redelivered event (the bridge reuses the domain event id), so no double send.
            dedupeKey: `${ctx.event.id}:${ctx.automation.id}:${ctx.actionIdx}`,
            ...systemSource(ctx),
          }),
        );
      },
    },
  },
};
