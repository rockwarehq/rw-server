import type { ActionHandler } from "@rw/automations";
import { sendAlertEmail } from "@rw/services/email/index";
import { getUserById } from "@rw/services/user/automation-ref";

export const handler: ActionHandler = {
  type: "sendAlert",
  displayName: "Send Alert",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["text", "recipientUserIds"],
        properties: {
          subject: {
            type: "string",
            title: "Alert Subject",
            description: "Email subject. Supports {{event.payload.*}} variables. Defaults to the event name if blank.",
          },
          text: {
            type: "string",
            title: "Alert Text",
            description: "Message body to email. Supports {{event.payload.*}} variables.",
          },
          recipientUserIds: {
            type: "array",
            items: { type: "string" },
            title: "Recipients",
            description: "Pick one or more users; the alert logs each user's email.",
            ref: { source: "users", multi: true },
          },
        },
      },
      async run(inputs, ctx) {
        const text = String(inputs.text ?? "");
        const subject = String(inputs.subject ?? "").trim() || ctx.automation.event;
        const ids = Array.isArray(inputs.recipientUserIds) ? inputs.recipientUserIds.map(String) : [];

        const recipients: string[] = [];
        for (const id of ids) {
          const user = await getUserById(id);
          if (user) recipients.push(user.email);
          else console.warn(`[automations] sendAlert: unknown user id "${id}" — skipped`);
        }

        if (recipients.length === 0) {
          console.warn(`[automations] sendAlert (${ctx.automation.label}): no recipients resolved — skipped`);
          return;
        }

        const result = await sendAlertEmail({ to: recipients, subject, message: text });
        if (!result.success) {
          throw new Error(`sendAlert email failed: ${result.error}`);
        }
      },
    },
  },
};
