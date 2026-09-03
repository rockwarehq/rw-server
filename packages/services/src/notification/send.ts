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
 * (their event id + action index) so a redelivered event never sends twice. Recipients are the
 * members of every group plus the listed employees, each person once.
 */
export interface SendNotificationInput {
  groupIds?: string[];
  employeeIds?: string[];
  /** Required when no group is given (a group's site is used otherwise). */
  siteId?: string;
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
  const groupIds = [...new Set(input.groupIds ?? [])];
  const employeeIds = [...new Set(input.employeeIds ?? [])];
  const groups = await prisma.notificationGroup.findMany({
    where: { id: { in: groupIds }, archivedAt: null },
    select: {
      id: true,
      name: true,
      siteId: true,
      channels: true,
      members: { select: { id: true, version: { select: { email: true, phone: true } } } },
    },
  });
  if (groups.length !== groupIds.length) return { error: "Notification group not found", code: "GROUP_NOT_FOUND" };

  const siteId = groups[0]?.siteId ?? input.siteId;
  if (!siteId) return { error: "A group or a site is required", code: "NO_RECIPIENTS" };
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { workspaceId: true } });
  if (!site) return { error: "Site not found", code: "SITE_NOT_FOUND" };

  const people = await prisma.employee.findMany({
    where: { id: { in: employeeIds }, workspaceId: site.workspaceId },
    select: { id: true, version: { select: { email: true, phone: true } } },
  });
  if (people.length !== employeeIds.length) {
    return { error: "One or more employees not found for this workspace", code: "EMPLOYEE_NOT_FOUND" };
  }

  // Each person once, even if they are in two groups and listed directly.
  const members = new Map([...groups.flatMap((g) => g.members), ...people].map((m) => [m.id, m]));
  if (members.size === 0) return { error: "No recipients", code: "NO_RECIPIENTS" };
  const channels = [...new Set([...groups.flatMap((g) => g.channels), ...(people.length ? ["EMAIL" as const] : [])])];
  const groupName = groups.length ? groups.map((g) => g.name).join(", ") : null;

  if (input.dedupeKey) {
    const existing = await findByDedupeKey(input.dedupeKey);
    if (existing) return { data: existing, deduped: true };
  }

  let notification: { id: string };
  try {
    notification = await prisma.notification.create({
      data: {
        siteId,
        groupId: groups[0]?.id ?? null,
        groupName,
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

  const recipients = [...members.values()].map((m) => ({
    id: m.id,
    addresses: { EMAIL: m.version?.email, SMS: m.version?.phone },
  }));
  const deliveries = await notifier.deliver(recipients, channels, { subject: input.subject, body: input.body });
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
    groupId: full.groupId ?? undefined,
    groupName: full.groupName ?? undefined,
    workspaceId: site.workspaceId,
    siteId,
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
