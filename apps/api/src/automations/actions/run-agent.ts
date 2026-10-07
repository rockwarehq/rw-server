import type { ActionHandler } from "@rw/automations";

import { resolveAgent } from "../../agent/agents.js";
import { enqueueRun } from "../../agent/queue.js";
import { admitInput, createSession } from "../../agent/sessions.js";
import { stableUuid } from "../../agent/triggers.js";

// Start an agent run from an automation: any automation event (or the daily
// clock) can hand a situation to an agent. The agent acts as its run-as user,
// so only custom agents with one can be started this way.

export const handler: ActionHandler = {
  type: "runAgent",
  displayName: "Run agent",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["agentKey", "prompt"],
        properties: {
          agentKey: {
            type: "string",
            title: "Agent",
            description: "The key of one of this site's agents (it must have a run-as user).",
          },
          prompt: {
            type: "string",
            title: "Instructions",
            description: "What the agent should do. Supports {{event.payload.*}} variables.",
          },
        },
      },
      async run(inputs, ctx) {
        const siteId = ctx.event.partition;
        if (!siteId) throw new Error(`automation "${ctx.automation.label}": run-agent needs a site`);
        const agentKey = String(inputs.agentKey ?? "").trim();
        const agent = await resolveAgent(siteId, agentKey);
        if (!agent?.enabled) throw new Error(`automation "${ctx.automation.label}": agent "${agentKey}" not found`);
        if (!agent.runAsUserId) {
          throw new Error(`automation "${ctx.automation.label}": agent "${agentKey}" has no run-as user`);
        }
        // Stable across a redelivered event: the same firing reuses its session.
        const triggerRef = `automation:${ctx.automation.id}:${ctx.event.id}:${ctx.actionIdx}`;
        const { session, created } = await createSession({
          siteId,
          agentKey: agent.key,
          agentVersion: agent.version,
          actorUserId: agent.runAsUserId,
          title: `${ctx.automation.label}: ${ctx.event.type}`,
          trigger: ctx.event.type === "time.daily" ? "SCHEDULE" : "HOOK_EVENT",
          triggerRef,
        });
        if (created) {
          const event = { automation: ctx.automation.label, type: ctx.event.type, payload: ctx.event.payload };
          await admitInput(session.id, {
            id: stableUuid(triggerRef),
            text: `<trigger_event>\n${JSON.stringify(event, null, 2)}\n</trigger_event>\n\n${String(inputs.prompt)}`,
          });
        }
        await enqueueRun(session.id, "automation");
      },
    },
  },
};
