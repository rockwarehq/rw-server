import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import type { OverheadPageLog, OverheadPageLogStatus } from "@rw/db";
import type { AnnouncementMessage } from "@rw/runtime/announce-subjects";
import { deliver, describeUnheard } from "../device/gateway/announce.js";
import type { PageSettings } from "./pages.js";

// Sending an overhead page by hand. Every attempt is logged (OverheadPageLog),
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

/**
 * Publish the page to its gateways and log the outcome: SENT (every gateway),
 * PARTIAL (some were offline/disabled) or FAILED (none). Delivery problems are
 * recorded on the log rather than returned as errors.
 */
export async function sendPage(input: SendPageInput): Promise<{ data: OverheadPageLog }> {
  const id = randomUUID();
  const gatewayIds = [...new Set(input.gatewayIds)];
  const result = await deliver({
    gatewayIds,
    siteId: input.siteId,
    message: toAnnouncement(id, input),
  });

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
      id,
      siteId: input.siteId,
      pageId: input.pageId ?? null,
      pageName: input.pageName ?? null,
      text: input.text.trim(),
      gatewayIds,
      priority: input.priority ?? "NORMAL",
      chimeBefore: input.chimeBefore ?? null,
      chimeAfter: input.chimeAfter ?? null,
      repeat: input.repeat ?? 1,
      voice: input.voice ?? null,
      speed: input.speed ?? null,
      status,
      error,
      sentByUserId: input.sentByUserId ?? null,
      sentByName: input.sentByName ?? null,
    },
  });
  return { data: log };
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
