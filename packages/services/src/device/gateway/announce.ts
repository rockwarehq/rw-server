import prisma from "@rw/db";
import type { AnnouncementMessage } from "@rw/runtime/announce-subjects";
import { errorResult } from "../../entity/types.js";

// Spoken announcements on on-prem gateways (rw-gateway src/announcer). Nothing is
// persisted: the automation run records the outcome, and an announcement is
// meaningless once stale, so there is no queue to retry from.

export type AnnouncementSink = (gatewayId: string, message: AnnouncementMessage) => void | Promise<void>;

let announcementSink: AnnouncementSink | null = null;

// apps/api wires this to a core NATS publish on announce.<gatewayId>. Null
// (workers, tests, no NATS) makes announce() fail with ANNOUNCE_UNAVAILABLE.
export function setAnnouncementSink(sink: AnnouncementSink | null): void {
  announcementSink = sink;
}

export interface AnnounceInput {
  gatewayIds: string[];
  /** Restricts targets to this site's gateways. */
  siteId?: string;
  message: AnnouncementMessage;
}

/**
 * Send one announcement to each gateway. Gateways that are disabled, or whose
 * last status is OFFLINE (the message would be dropped), are reported as an
 * error after the rest have been sent, so the run shows who didn't hear it.
 */
export async function announce(input: AnnounceInput) {
  const text = input.message.text?.trim();
  if (!text) return errorResult("ANNOUNCE_TEXT_REQUIRED", "Announcement text is required");

  const ids = [...new Set(input.gatewayIds.filter(Boolean))];
  if (ids.length === 0) return errorResult("ANNOUNCE_NO_GATEWAYS", "Pick at least one gateway");

  const sink = announcementSink;
  if (!sink) return errorResult("ANNOUNCE_UNAVAILABLE", "Announcements need NATS, which is not connected");

  const gateways = await prisma.gateway.findMany({
    where: { id: { in: ids }, ...(input.siteId ? { siteId: input.siteId } : {}) },
    select: { id: true, name: true, status: true },
  });
  const found = new Set(gateways.map((g) => g.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    return errorResult(
      "GATEWAY_NOT_FOUND",
      `Gateway not found${input.siteId ? " on this site" : ""}: ${missing.join(", ")}`,
    );
  }

  const message = { ...input.message, text };
  const sent: string[] = [];
  const notHeard: string[] = [];
  for (const gateway of gateways) {
    if (gateway.status === "DISABLED") {
      notHeard.push(`${gateway.name} (disabled)`);
      continue;
    }
    await sink(gateway.id, message);
    if (gateway.status === "OFFLINE") notHeard.push(`${gateway.name} (offline)`);
    else sent.push(gateway.id);
  }

  if (notHeard.length) {
    return errorResult("GATEWAY_UNAVAILABLE", `Not announced on: ${notHeard.join(", ")}`);
  }
  return { data: { gatewayIds: sent } };
}
