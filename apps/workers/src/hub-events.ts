// Polls rw-hub's down-channel and applies carrier consent changes and SMS delivery outcomes.
// Polling, not push: this may run on a plant network with no inbound port.
// Needs DATABASE_URL, HUB_URL, HUB_API_KEY.

import prisma from "@rw/db";
import type { SmsConsentMethod, SmsConsentStatus } from "@rw/db";
import { type HubEvent, isHubEnabled, readEvents } from "@rw/runtime/hub";
import { applyFromHub, isUniqueViolation, workspacesForPhone } from "@rw/services/notification/index";

const POLL_INTERVAL_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function startHubEvents(): Promise<void> {
  if (!isHubEnabled()) {
    console.log("[hub-events] HUB_URL / HUB_API_KEY unset — not polling");
    return;
  }
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  void tick();
  console.log(`[hub-events] polling every ${POLL_INTERVAL_MS}ms`);
}

export async function stopHubEvents(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (running) return; // a slow hub must not overlap two batches
  running = true;
  try {
    const cursor = await loadCursor();
    const page = await readEvents(cursor);
    if (!page.ok) {
      console.warn(`[hub-events] poll failed: ${page.error}`);
      return;
    }
    if (page.data.events.length === 0) return;

    for (const event of page.data.events) {
      if (event.type === "sms.consent.changed") await applyConsent(event);
      else if (event.type === "sms.message.status") await applyDeliveryStatus(event);
    }

    // Cursor moves only after the whole batch applied; a replay is idempotent on both paths.
    await saveCursor(page.data.cursor);
    console.log(`[hub-events] applied ${page.data.events.length} event(s), cursor=${page.data.cursor}`);
  } catch (err) {
    console.error("[hub-events] tick failed", err);
  } finally {
    running = false;
  }
}

const CONSENT_METHODS = new Set<SmsConsentMethod>([
  "WEB_FORM",
  "VERBAL",
  "PAPER",
  "TEXT_KEYWORD",
  "STOP_KEYWORD",
  "IMPORTED",
]);

async function applyConsent(event: HubEvent): Promise<void> {
  const phone = String(event.payload.phone ?? "");
  const status = event.payload.status as SmsConsentStatus;
  if (!phone || (status !== "OPTED_IN" && status !== "OPTED_OUT")) return;
  // The hub reports how consent was captured (a carrier keyword, or another tenant's paper form).
  const reported = event.payload.method as SmsConsentMethod;
  const method = CONSENT_METHODS.has(reported) ? reported : status === "OPTED_OUT" ? "STOP_KEYWORD" : "TEXT_KEYWORD";

  // Only workspaces already tracking this number; one with no row never asked.
  for (const workspaceId of await workspacesForPhone(phone)) {
    try {
      await applyFromHub({
        workspaceId,
        phone,
        status,
        method,
        decidedAt: new Date(event.occurredAt),
        relayEventId: event.id,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // already applied on an earlier attempt
    }
  }
}

/** Twilio callback statuses only. QUEUED adds nothing: the row already says SENT. */
const DELIVERY_STATUS = {
  SENT: "SENT",
  DELIVERED: "SENT",
  UNDELIVERED: "FAILED",
  FAILED: "FAILED",
} as const;

async function applyDeliveryStatus(event: HubEvent): Promise<void> {
  const hubMessageId = String(event.payload.messageId ?? "");
  const status = DELIVERY_STATUS[event.payload.status as keyof typeof DELIVERY_STATUS];
  if (!hubMessageId || !status) return;

  const errorCode = event.payload.errorCode;
  await prisma.notificationDelivery.updateMany({
    where: { channel: "SMS", providerMessageId: hubMessageId },
    data: { status, ...(errorCode ? { error: `carrier error ${errorCode}` } : {}) },
  });
}

async function loadCursor(): Promise<string> {
  const row = await prisma.hubCursor.findUnique({ where: { id: "singleton" } });
  return row?.cursor ?? "0";
}

async function saveCursor(cursor: string): Promise<void> {
  await prisma.hubCursor.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", cursor },
    update: { cursor },
  });
}
