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

export interface UnheardGateway {
  id: string;
  name: string;
  reason: "offline" | "disabled";
}

/**
 * Send one announcement to each gateway and report who didn't hear it: disabled
 * gateways are skipped, and ones whose last status is OFFLINE are still sent to
 * (the status may be stale) but counted as not heard.
 */
export async function deliver(input: AnnounceInput) {
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
  const heard: string[] = [];
  const unheard: UnheardGateway[] = [];
  for (const gateway of gateways) {
    if (gateway.status === "DISABLED") {
      unheard.push({ id: gateway.id, name: gateway.name, reason: "disabled" });
      continue;
    }
    await sink(gateway.id, message);
    if (gateway.status === "OFFLINE") unheard.push({ id: gateway.id, name: gateway.name, reason: "offline" });
    else heard.push(gateway.id);
  }
  return { data: { gatewayIds: heard, unheard } };
}

/** "Line 2 (offline), Line 3 (disabled)" */
export function describeUnheard(unheard: UnheardGateway[]): string {
  return unheard.map((g) => `${g.name} (${g.reason})`).join(", ");
}

/**
 * deliver(), with any gateway that didn't hear it reported as an error (after
 * the rest have been sent), so an automation run shows who missed it.
 */
export async function announce(input: AnnounceInput) {
  const result = await deliver(input);
  if ("error" in result) return result;
  if (result.data.unheard.length) {
    return errorResult("GATEWAY_UNAVAILABLE", `Not announced on: ${describeUnheard(result.data.unheard)}`);
  }
  return { data: { gatewayIds: result.data.gatewayIds } };
}
