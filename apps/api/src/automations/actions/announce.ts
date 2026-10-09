import type { ActionContext, ActionHandler } from "@rw/automations";
import type { AnnouncementMessage } from "@rw/runtime/announce-subjects";
import { announcements } from "@rw/services/device/gateway/index";
import { unwrapService } from "./shared.js";

// Kokoro's voices (rw-gateway packages/rw-tts-kokoro). "default" is the gateway's
// configured default; a gateway that later switches engine falls back to its
// default for an id it doesn't know, so these never stop an announcement.
const VOICES = [
  "default",
  ...["af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova"],
  ...["af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam"],
  ...["am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily"],
  ...["bm_daniel", "bm_fable", "bm_george", "bm_lewis"],
];

const ids = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

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

function onOff(value: unknown): boolean | undefined {
  const s = text(value)?.toLowerCase();
  return s === "on" ? true : s === "off" ? false : undefined;
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
    chimeBefore: onOff(inputs.chimeBefore),
    chimeAfter: onOff(inputs.chimeAfter),
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
        required: ["gatewayIds", "text"],
        properties: {
          gatewayIds: {
            type: "array",
            items: { type: "string" },
            title: "Gateways",
            description: "On-prem gateways whose speaker plays the announcement.",
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
            enum: ["on", "off"],
            title: "Chime before",
            description: "Blank = the gateway's setting (on).",
          },
          chimeAfter: {
            type: "string",
            enum: ["on", "off"],
            title: "Chime after",
            description: "Blank = the gateway's setting (off).",
          },
          repeat: { type: "number", title: "Times to speak", description: "1–10. Default 1." },
          voice: {
            type: "string",
            enum: VOICES,
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
        const gatewayIds = ids(inputs.gatewayIds);
        if (gatewayIds.length === 0) {
          throw new Error(`automation "${ctx.automation.label}": announce needs at least one gateway`);
        }
        unwrapService(
          await announcements.announce({
            gatewayIds,
            siteId: ctx.event.partition,
            message: buildAnnouncement(inputs, ctx),
          }),
        );
      },
    },
  },
};
