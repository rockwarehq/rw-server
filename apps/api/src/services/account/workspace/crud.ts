import prisma from "@rw/db";
import { countMembers } from "./members.js";

// The account's workspace. There is exactly one per deployment (see the
// singleton guard on Workspace), so there is no create, list or delete.

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
  description?: string;
  settings?: Record<string, unknown>;
}

export async function getById(id: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id } });
  return workspace ? { ...workspace, _count: { members: await countMembers() } } : null;
}

export async function update(id: string, input: UpdateWorkspaceInput) {
  const { name, slug, description, settings } = input;

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (slug !== undefined) updateData.slug = slug;
  if (description !== undefined) updateData.description = description;
  if (settings !== undefined) updateData.settings = settings;

  return prisma.workspace.update({
    where: { id },
    data: updateData,
  });
}

export async function exists(id: string): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!workspace;
}

/**
 * GET /workspaces: the account's workspace, as a one-item list in the shape
 * the membership list used to have. Shipped console builds read this at
 * boot, so the shape stays.
 */
export async function listForUser(userId: string) {
  const [workspace, user] = await Promise.all([
    prisma.workspace.findFirst({ select: { id: true, name: true, slug: true, description: true } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        createdAt: true,
        isAccountAdmin: true,
        employee: {
          select: {
            id: true,
            status: true,
            version: {
              select: {
                id: true,
                version: true,
                firstName: true,
                lastName: true,
                employeeNumber: true,
                badgeNumber: true,
              },
            },
          },
        },
      },
    }),
  ]);
  if (!workspace || !user) return [];
  return [
    {
      ...workspace,
      workspace,
      joinedAt: user.createdAt,
      employee: user.employee,
      isAccountAdmin: user.isAccountAdmin,
      workspaceRole: user.isAccountAdmin ? ("OWNER" as const) : ("MEMBER" as const),
    },
  ];
}
