import type { ActionHandler } from "@rw/automations";
import { getUserById } from "@rw/services/user/automation-ref";

/**
 * `sendAlert` — logs an alert text and the resolved emails of one or more picked users.
 *
 * Recipients are users because only `User` carries an email (employees don't — see
 * `@rw/services/user/automation-ref`). Per-version `inputSchema` + `run` live together so they
 * can't disagree. Stored input is user ids; the handler resolves them to emails at run time via
 * `@rw/services/user/automation-ref` (no framework hydration today, see @rw/automations README
 * "Ref data sources").
 *
 * Add a new version (e.g. switch from a flat `recipientUserIds` to a structured
 * `{ to: [ids], cc: [ids] }`) by adding a `"2"` entry; v1 automations keep running against the v1
 * handler. Bump `latest` when the editor should default to the new version for new automations.
 */
export const handler: ActionHandler = {
  type: "sendAlert",
  displayName: "Send Alert",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["text", "recipientUserIds"],
        properties: {
          text: {
            type: "string",
            title: "Alert Text",
            description: "Message to log. Supports {{event.payload.*}} variables.",
          },
          recipientUserIds: {
            type: "array",
            items: { type: "string" },
            title: "Recipients",
            description: "Pick one or more users; the alert logs each user's email.",
            // Editor renders a multi-select populated by `RefRegistry.list("users")` (see
            // @rw/services/user/automation-ref). Stored value is `string[]` of user ids;
            // handler resolves ids → emails at run time.
            ref: { source: "users", multi: true },
          },
        },
      },
      async run(inputs, ctx) {
        const text = String(inputs.text ?? "");
        const ids = Array.isArray(inputs.recipientUserIds) ? inputs.recipientUserIds.map(String) : [];

        const recipients: string[] = [];
        for (const id of ids) {
          const user = await getUserById(id);
          if (user) recipients.push(user.email);
          else console.warn(`[automations] sendAlert: unknown user id "${id}" — skipped`);
        }

        console.log(
          `[automations] ALERT (${ctx.automation.label}): ${text} -> ${recipients.join(", ") || "(no recipients)"}`,
        );
      },
    },
  },
};
