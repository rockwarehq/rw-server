import { randomUUID } from "node:crypto";
import prisma, { type Prisma } from "@rw/db";
import type { OverheadPageLog, OverheadPageLogStatus, OverheadPagePriority } from "@rw/db";
import type { AnnouncementMessage } from "@rw/runtime/announce-subjects";
import { deliver, describeUnheard } from "../device/gateway/announce.js";
import type { PageSettings } from "./pages.js";

// Sending overhead pages — by hand from the paging page, or from an
// automation's announce action. Every attempt is logged (OverheadPageLog),
// including ones that reached no gateway, so the log answers "who paged what".

type ServiceError = { error: string; code: string };

export interface SendPageInput extends PageSettings {
  siteId: string;
  /** Set when sent from a saved page. */
  pageId?: string;
  pageName?: string;
  sentByUserId?: string;
  sentByName?: string;
}

/** "off" = no chime, a name = that chime, unset = the gateway's setting. */
function chime(value: string | null | undefined): boolean | string | undefined {
  if (!value) return undefined;
  return value === "off" ? false : value;
}

/** The gateway message for a page. Exported for tests. */
export function toAnnouncement(id: string, page: PageSettings): AnnouncementMessage {
  const message: AnnouncementMessage = {
    // The gateway speaks a given id once.
    id,
    text: page.text.trim(),
    priority: page.priority ? (page.priority.toLowerCase() as AnnouncementMessage["priority"]) : undefined,
    chimeBefore: chime(page.chimeBefore),
    chimeAfter: chime(page.chimeAfter),
    repeat: page.repeat,
    voice: page.voice || undefined,
    speed: page.speed ?? undefined,
  };
  return Object.fromEntries(Object.entries(message).filter(([, v]) => v !== undefined)) as AnnouncementMessage;
}

type LogFields = Omit<
  Prisma.OverheadPageLogUncheckedCreateInput,
  "id" | "siteId" | "text" | "gatewayIds" | "status" | "error" | "createdAt"
>;

/**
 * Publish a message to its gateways and log the outcome: SENT (every gateway),
 * PARTIAL (some were offline/disabled) or FAILED (none). Delivery problems are
 * recorded on the log rather than returned as errors.
 */
async function deliverAndLog(input: {
  logId: string;
  siteId: string;
  gatewayIds: string[];
  message: AnnouncementMessage;
  fields: LogFields;
}): Promise<{ data: OverheadPageLog }> {
  const gatewayIds = [...new Set(input.gatewayIds)];
  const result = await deliver({ gatewayIds, siteId: input.siteId, message: input.message });

  let status: OverheadPageLogStatus;
  let error: string | null = null;
  if ("error" in result) {
    status = "FAILED";
    error = result.error;
  } else if (result.data.unheard.length === 0) {
    status = "SENT";
  } else {
    status = result.data.gatewayIds.length ? "PARTIAL" : "FAILED";
    error = `Not announced on: ${describeUnheard(result.data.unheard)}`;
  }

  const log = await prisma.overheadPageLog.create({
    data: {
      ...input.fields,
      id: input.logId,
      siteId: input.siteId,
      text: input.message.text.trim(),
      gatewayIds,
      status,
      error,
    },
  });
  return { data: log };
}

/** A page from the paging page: typed by hand, or a saved page. */
export async function sendPage(input: SendPageInput): Promise<{ data: OverheadPageLog }> {
  const id = randomUUID();
  return deliverAndLog({
    logId: id,
    siteId: input.siteId,
    gatewayIds: input.gatewayIds,
    message: toAnnouncement(id, input),
    fields: {
      pageId: input.pageId ?? null,
      pageName: input.pageName ?? null,
      priority: input.priority ?? "NORMAL",
      chimeBefore: input.chimeBefore ?? null,
      chimeAfter: input.chimeAfter ?? null,
      repeat: input.repeat ?? 1,
      voice: input.voice ?? null,
      speed: input.speed ?? null,
      source: "MANUAL",
      sourceType: "user",
      sourceRef: input.sentByUserId ?? null,
      sentByUserId: input.sentByUserId ?? null,
      sentByName: input.sentByName ?? null,
    },
  });
}

/** A chime value on the message as the log stores it: "off", a name, or null (the gateway's own). */
function chimeColumn(value: boolean | string | undefined): string | null {
  if (value === false) return "off";
  return typeof value === "string" && value ? value : null;
}

/**
 * An automation's announce action. The message keeps its own id (stable per
 * event, so the gateway speaks a redelivered event once); the log names the
 * automation as the sender.
 */
export async function sendAutomationPage(input: {
  siteId: string;
  gatewayIds: string[];
  message: AnnouncementMessage;
  automation: { id: string; label: string };
}): Promise<{ data: OverheadPageLog }> {
  const { message } = input;
  return deliverAndLog({
    logId: randomUUID(),
    siteId: input.siteId,
    gatewayIds: input.gatewayIds,
    message,
    fields: {
      priority: message.priority ? (message.priority.toUpperCase() as OverheadPagePriority) : "NORMAL",
      chimeBefore: chimeColumn(message.chimeBefore),
      chimeAfter: chimeColumn(message.chimeAfter),
      repeat: message.repeat ?? 1,
      voice: message.voice ?? null,
      speed: message.speed ?? null,
      source: "SYSTEM",
      sourceType: "automation",
      sourceRef: input.automation.id,
      sentByName: input.automation.label,
    },
  });
}

/** Send a saved page exactly as saved. */
export async function sendSavedPage(input: {
  id: string;
  sentByUserId?: string;
  sentByName?: string;
}): Promise<ServiceError | { data: OverheadPageLog }> {
  const page = await prisma.overheadPage.findUnique({ where: { id: input.id } });
  if (!page || page.archivedAt) return { error: "Overhead page not found", code: "OVERHEAD_PAGE_NOT_FOUND" };
  return sendPage({
    siteId: page.siteId,
    pageId: page.id,
    pageName: page.name,
    text: page.text,
    gatewayIds: page.gatewayIds,
    priority: page.priority,
    chimeBefore: page.chimeBefore,
    chimeAfter: page.chimeAfter,
    repeat: page.repeat,
    voice: page.voice,
    speed: page.speed,
    sentByUserId: input.sentByUserId,
    sentByName: input.sentByName,
  });
}

/** Newest first. */
export async function listLogs(input: { siteId: string; pageId?: string; limit?: number; offset?: number }) {
  const { siteId, pageId, limit = 50, offset = 0 } = input;
  const where = { siteId, ...(pageId ? { pageId } : {}) };
  const [data, total] = await Promise.all([
    prisma.overheadPageLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...(limit > 0 ? { take: limit, skip: offset } : {}),
    }),
    prisma.overheadPageLog.count({ where }),
  ]);
  return { data, total, limit, offset };
}
