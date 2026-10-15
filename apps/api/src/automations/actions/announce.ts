import type { ActionContext, ActionHandler } from "@rw/automations";
import { ANNOUNCE_CHIMES, ANNOUNCE_VOICES, type AnnouncementMessage } from "@rw/runtime/announce-subjects";
import * as paging from "@rw/services/paging/index";

// Inputs arrive as typed by the editor, or as strings after {{event.*}}
// interpolation; blanks mean "the gateway's default" and are left out.
function text(value: unknown): string | undefined {
  const s = value == null ? "" : String(value).trim();
  return s || undefined;
}

function number(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(text(value) ?? Number.NaN);
  return Number.isFinite(n) ? n : undefined;
}

// "off" = no chime, a name = that chime, blank = the gateway's setting for the
// slot. "on" (version 1's original choice, still in saved automations) = the
// gateway's chime for the slot.
function chime(value: unknown): boolean | string | undefined {
  const s = text(value)?.toLowerCase();
  if (!s) return undefined;
  if (s === "on") return true;
  if (s === "off") return false;
  return s;
}

/** The message sent to each gateway. Exported for tests. */
export function buildAnnouncement(
  inputs: Record<string, unknown>,
  ctx: ActionContext,
  now = Date.now(),
): AnnouncementMessage {
  const priority = text(inputs.priority);
  const expiresInSeconds = number(inputs.expiresInSeconds);
  const message: AnnouncementMessage = {
    // Stable across a redelivered event, so the gateway speaks it once.
    id: `${ctx.event.id}:${ctx.automation.id}:${ctx.actionIdx}`,
    text: String(inputs.text ?? "").trim(),
    voice: text(inputs.voice),
    speed: number(inputs.speed),
    chimeBefore: chime(inputs.chimeBefore),
    chimeAfter: chime(inputs.chimeAfter),
    repeat: number(inputs.repeat),
    priority: priority === "normal" || priority === "high" || priority === "emergency" ? priority : undefined,
    expiresAt: expiresInSeconds && expiresInSeconds > 0 ? now + expiresInSeconds * 1000 : undefined,
  };
  return Object.fromEntries(Object.entries(message).filter(([, v]) => v !== undefined)) as AnnouncementMessage;
}

export const handler: ActionHandler = {
  type: "announce",
  displayName: "Announce on gateway speaker",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["text"],
        properties: {
          gatewayIds: {
            type: "array",
            items: { type: "string" },
            title: "Speakers",
            description: "Blank = every speaker at the plant.",
            ref: { source: "gateways", multi: true },
          },
          text: {
            type: "string",
            title: "Message",
            description: "Spoken aloud. Supports {{event.payload.*}} variables.",
          },
          priority: {
            type: "string",
            enum: ["normal", "high", "emergency"],
            title: "Priority",
            description:
              "Normal waits its turn. High plays ahead of waiting normal announcements. Emergency stops whatever is playing and plays next.",
          },
          chimeBefore: {
            type: "string",
            enum: ["off", ...ANNOUNCE_CHIMES],
            title: "Chime before",
            description: "Blank = the gateway's setting (alert).",
          },
          chimeAfter: {
            type: "string",
            enum: ["off", ...ANNOUNCE_CHIMES],
            title: "Chime after",
            description: "Blank = the gateway's setting (none).",
          },
          repeat: { type: "number", title: "Times to speak", description: "1–10. Default 1." },
          voice: {
            type: "string",
            enum: [...ANNOUNCE_VOICES],
            title: "Voice",
            description: "Blank or default = the gateway's voice.",
          },
          speed: { type: "number", title: "Speed", description: "0.5–2, 1 = normal. Blank = the gateway's speed." },
          expiresInSeconds: {
            type: "number",
            title: "Expires after (seconds)",
            description: "Not spoken if it can't play within this time. Default 60.",
          },
        },
      },
      async run(inputs, ctx) {
        const siteId = ctx.event.partition;
        // Speakers are per plant; global (site-less) automations predate site partitioning.
        if (!siteId) throw new Error(`automation "${ctx.automation.label}": announce needs a plant`);
        const message = buildAnnouncement(inputs, ctx);
        // Picked speakers, or none = every speaker at the plant, resolved when sent
        // (a speaker added later is included).
        const gatewayIds = Array.isArray(inputs.gatewayIds) ? inputs.gatewayIds.map(String).filter(Boolean) : [];
        // Logged with the plant's manual pages (Recent pages), sent by this automation.
        const { data: log } = await paging.sendAutomationPage({
          siteId,
          gatewayIds,
          message,
          automation: { id: ctx.automation.id, label: ctx.automation.label },
        });
        // A page that missed a speaker fails the run, so the run history shows who missed it.
        if (log.status !== "SENT") throw new Error(log.error ?? `announce ${log.status.toLowerCase()}`);
      },
    },
  },
};
