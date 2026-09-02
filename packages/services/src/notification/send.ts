import prisma, { type Prisma } from "@rw/db";
import type { ActionSource } from "@rw/db";
import { summarize } from "@rw/notifications";
import type { EventCause } from "@rw/runtime/domain-events";
import { publishNotificationEvent } from "./events.js";
import { isUniqueViolation } from "./group.js";
import { notifier } from "./notifier.js";

const notificationInclude = {
  deliveries: { orderBy: { createdAt: "asc" } },
} as const;

export type NotificationRecord = Prisma.NotificationGetPayload<{ include: typeof notificationInclude }>;
type ServiceError = { error: string; code: string };

/**
 * The programmatic entry point: automations call this with source SYSTEM and a `dedupeKey`
 * (their event id + action index) so a redelivered event never sends twice.
 */
export interface SendNotificationInput {
  groupId: string;
  subject: string;
  body: string;
  /** MANUAL = a person sending from the UI; SYSTEM (default) = automation/alarm. */
  source?: ActionSource;
  sourceType?: string;
  sourceRef?: string;
  dedupeKey?: string;
  /** Automation chain this notification continues; carried onto the emitted event. */
  cause?: EventCause;
}

const findByDedupeKey = (dedupeKey: string) =>
  prisma.notification.findUnique({ where: { dedupeKey }, include: notificationInclude });

export async function send(
  input: SendNotificationInput,
): Promise<ServiceError | { data: NotificationRecord; deduped?: boolean }> {
  const group = await prisma.notificationGroup.findUnique({
    where: { id: input.groupId },
    select: {
      id: true,
      name: true,
      siteId: true,
      channels: true,
      archivedAt: true,
      site: { select: { workspaceId: true } },
      members: { select: { id: true, version: { select: { email: true, phone: true } } } },
    },
  });
  if (!group || group.archivedAt) return { error: "Notification group not found", code: "GROUP_NOT_FOUND" };

  if (input.dedupeKey) {
    const existing = await findByDedupeKey(input.dedupeKey);
    if (existing) return { data: existing, deduped: true };
  }

  let notification: { id: string };
  try {
    notification = await prisma.notification.create({
      data: {
        siteId: group.siteId,
        groupId: group.id,
        groupName: group.name,
        subject: input.subject,
        body: input.body,
        source: input.source ?? "SYSTEM",
        sourceType: input.sourceType ?? null,
        sourceRef: input.sourceRef ?? null,
        dedupeKey: input.dedupeKey ?? null,
      },
      select: { id: true },
    });
  } catch (err) {
    // Lost a race on dedupeKey: the other caller's notification is the one that counts.
    const existing = input.dedupeKey && isUniqueViolation(err) ? await findByDedupeKey(input.dedupeKey) : null;
    if (existing) return { data: existing, deduped: true };
    throw err;
  }

  const recipients = group.members.map((m) => ({
    id: m.id,
    addresses: { EMAIL: m.version?.email, SMS: m.version?.phone },
  }));
  const deliveries = await notifier.deliver(recipients, group.channels, { subject: input.subject, body: input.body });
  await prisma.notificationDelivery.createMany({
    data: deliveries.map(({ recipientId, ...row }) => ({
      notificationId: notification.id,
      employeeId: recipientId,
      ...row,
    })),
  });

  const full = await prisma.notification.findUniqueOrThrow({
    where: { id: notification.id },
    include: notificationInclude,
  });
  const summary = summarize(deliveries);
  publishNotificationEvent({
    action: summary.sent > 0 ? "sent" : "failed",
    notificationId: full.id,
    groupId: group.id,
    groupName: group.name,
    workspaceId: group.site.workspaceId,
    siteId: group.siteId,
    subject: full.subject,
    source: full.source,
    sourceType: full.sourceType ?? undefined,
    sourceRef: full.sourceRef ?? undefined,
    ...summary,
    cause: input.cause,
  });
  return { data: full };
}

export async function list(filter: { siteId: string; groupId?: string; limit?: number; offset?: number }) {
  const { siteId, groupId, limit = 50, offset = 0 } = filter;
  const where = { siteId, ...(groupId ? { groupId } : {}) };
  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      include: notificationInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.notification.count({ where }),
  ]);
  return { data: notifications, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string) {
  const notification = await prisma.notification.findUnique({ where: { id }, include: notificationInclude });
  return notification ? { data: notification } : null;
}
