import { Prisma } from "./generated/client.js";
import prisma from "./client.js";

// The account: the one workspace this deployment serves. The Workspace
// table holds a single row (its singletonGuard is always 0 and unique), so
// nothing needs to pass a workspace around to find it.

/** The account's workspace. Throws until the first run has created it. */
export function accountWorkspace() {
  return prisma.workspace.findFirstOrThrow();
}

/**
 * The account's workspace, created on first use (seeds, first run, tests).
 * Two callers racing to create it both get the same row: the loser's
 * insert breaks the singleton guard and it reads the winner's instead.
 */
export async function ensureAccountWorkspace(data: Prisma.WorkspaceCreateInput) {
  const existing = await prisma.workspace.findFirst();
  if (existing) return existing;
  try {
    return await prisma.workspace.create({ data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return prisma.workspace.findFirstOrThrow();
    }
    throw err;
  }
}
