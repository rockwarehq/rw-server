import type { ActionHandler } from "@rw/automations";
import { getEmployeeById as getDbEmployeeById } from "@rw/services/employee/automation-ref";
import { getFixtureEmployeeById } from "../refs/index.js";

/**
 * `sendAlert` — logs an alert text and the resolved names of one or more picked employees.
 *
 * Per-version `inputSchema` + `run` live together so they can't disagree. Stored input is
 * employee ids; the handler resolves them to `Employee` objects at run time (no framework
 * hydration today, see @rw/automations README "Ref data sources").
 *
 * Lookup is workspaceId-dispatched: the file-mock e2e uses workspaceId `"dev"` against the
 * in-memory fixture in `refs/employees.ts`; real workspaces hit Postgres via
 * `@rw/services/employee/automation-ref`. This keeps the file e2e DB-free while production reads
 * the workspace's actual employees.
 *
 * TODO (deferred): email resolution. The handler logs names today; when email send lands, resolve
 * `employeeId → memberships[0]?.user.email` (or whichever membership the workspace identifies as
 * the contact). That join lives behind `getEmployeeById` so this handler doesn't grow Prisma calls.
 *
 * Add a new version (e.g. switch from a flat `recipientEmployeeIds` to a structured
 * `{ to: [ids], cc: [ids] }`) by adding a `"2"` entry; v1 automations keep running against the v1
 * handler. Bump `latest` when the editor should default to the new version for new automations.
 */
async function lookupEmployee(workspaceId: string, id: string): Promise<{ name: string } | undefined> {
  if (workspaceId === "dev") {
    return getFixtureEmployeeById(id);
  }
  return getDbEmployeeById(workspaceId, id);
}

export const handler: ActionHandler = {
  type: "sendAlert",
  displayName: "Send Alert",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["text", "recipientEmployeeIds"],
        properties: {
          text: {
            type: "string",
            title: "Alert Text",
            description: "Message to log. Supports {{event.payload.*}} variables.",
          },
          recipientEmployeeIds: {
            type: "array",
            items: { type: "string" },
            title: "Recipients",
            description: "Pick one or more employees; the alert logs each employee's name.",
            // Editor renders a multi-select populated by `RefRegistry.list("employees")` (see
            // refs/employees.ts in apps/api and @rw/services/employee/automation-ref in services).
            // Stored value is `string[]` of employee ids; handler resolves ids → names at run time.
            ref: { source: "employees", multi: true },
          },
        },
      },
      async run(inputs, ctx) {
        const text = String(inputs.text ?? "");
        const ids = Array.isArray(inputs.recipientEmployeeIds) ? inputs.recipientEmployeeIds.map(String) : [];

        const recipients: string[] = [];
        for (const id of ids) {
          const employee = await lookupEmployee(ctx.automation.workspaceId, id);
          if (employee) recipients.push(employee.name);
          else console.warn(`[automations] sendAlert: unknown employee id "${id}" — skipped`);
        }

        console.log(
          `[automations] ALERT (${ctx.automation.label}): ${text} -> ${recipients.join(", ") || "(no recipients)"}`,
        );
      },
    },
  },
};
