import type { ActionHandler } from "@rw/automations";
import * as notification from "@rw/services/notification/index";
import { systemSource, unwrapService } from "./shared.js";

export const handler: ActionHandler = {
  type: "notifyGroup",
  displayName: "Notify Group",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["groupId", "subject", "body"],
        properties: {
          groupId: { type: "string", title: "Group", ref: { source: "notificationGroups" } },
          subject: { type: "string", title: "Subject", description: "Supports {{event.payload.*}} variables." },
          body: { type: "string", title: "Message", description: "Supports {{event.payload.*}} variables." },
        },
      },
      async run(inputs, ctx) {
        unwrapService(
          await notification.send({
            groupId: String(inputs.groupId),
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
