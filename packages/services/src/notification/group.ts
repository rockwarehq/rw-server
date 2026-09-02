import prisma, { Prisma } from "@rw/db";
import type { NotificationChannel } from "@rw/db";

export const groupInclude = {
  members: {
    select: { id: true, version: { select: { firstName: true, lastName: true, email: true, phone: true } } },
  },
} as const;

export type NotificationGroupRecord = Prisma.NotificationGroupGetPayload<{ include: typeof groupInclude }>;
type ServiceError = { error: string; code: string };

const DUPLICATE_NAME: ServiceError = {
  error: "A notification group with this name already exists for this site",
  code: "DUPLICATE_NAME",
};
const NOT_FOUND: ServiceError = { error: "Notification group not found", code: "GROUP_NOT_FOUND" };

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export interface CreateGroupInput {
  siteId: string;
  name: string;
  description?: string;
  /** Defaults to [EMAIL]. */
  channels?: NotificationChannel[];
  memberIds?: string[];
}

export interface UpdateGroupInput {
  name?: string;
  description?: string | null;
  channels?: NotificationChannel[];
  /** Replaces the whole list. */
  memberIds?: string[];
}

/** All ids must be employees of the site's workspace. */
async function validateMembers(workspaceId: string, memberIds: string[]): Promise<ServiceError | null> {
  if (memberIds.length === 0) return null;
  const count = await prisma.employee.count({ where: { id: { in: memberIds }, workspaceId } });
  if (count !== new Set(memberIds).size) {
    return { error: "One or more employees not found for this workspace", code: "EMPLOYEE_NOT_FOUND" };
  }
  return null;
}

export async function createGroup(input: CreateGroupInput): Promise<ServiceError | { data: NotificationGroupRecord }> {
  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { workspaceId: true } });
  if (!site) return { error: "Site not found", code: "SITE_NOT_FOUND" };

  const memberIds = input.memberIds ?? [];
  const memberError = await validateMembers(site.workspaceId, memberIds);
  if (memberError) return memberError;

  try {
    const group = await prisma.notificationGroup.create({
      data: {
        siteId: input.siteId,
        name: input.name,
        description: input.description ?? null,
        channels: input.channels ?? ["EMAIL"],
        members: { connect: memberIds.map((id) => ({ id })) },
      },
      include: groupInclude,
    });
    return { data: group };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

export async function listGroups(filter: {
  siteId: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}) {
  const { siteId, includeArchived, limit = 50, offset = 0 } = filter;
  const where = { siteId, ...(includeArchived ? {} : { archivedAt: null }) };
  const [groups, total] = await Promise.all([
    prisma.notificationGroup.findMany({
      where,
      include: groupInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.notificationGroup.count({ where }),
  ]);
  return { data: groups, total, limit: Number(limit), offset: Number(offset) };
}

export async function getGroupById(id: string) {
  const group = await prisma.notificationGroup.findUnique({ where: { id }, include: groupInclude });
  return group && !group.archivedAt ? { data: group } : null;
}

export async function updateGroup(
  id: string,
  input: UpdateGroupInput,
): Promise<ServiceError | { data: NotificationGroupRecord }> {
  const existing = await prisma.notificationGroup.findUnique({
    where: { id },
    select: { archivedAt: true, site: { select: { workspaceId: true } } },
  });
  if (!existing || existing.archivedAt) return NOT_FOUND;

  if (input.memberIds) {
    const memberError = await validateMembers(existing.site.workspaceId, input.memberIds);
    if (memberError) return memberError;
  }

  try {
    const group = await prisma.notificationGroup.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        channels: input.channels,
        ...(input.memberIds ? { members: { set: input.memberIds.map((id) => ({ id })) } } : {}),
      },
      include: groupInclude,
    });
    return { data: group };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

export async function archiveGroup(id: string): Promise<ServiceError | { data: NotificationGroupRecord }> {
  const existing = await prisma.notificationGroup.findUnique({ where: { id }, select: { archivedAt: true } });
  if (!existing || existing.archivedAt) return NOT_FOUND;
  const group = await prisma.notificationGroup.update({
    where: { id },
    data: { archivedAt: new Date() },
    include: groupInclude,
  });
  return { data: group };
}
