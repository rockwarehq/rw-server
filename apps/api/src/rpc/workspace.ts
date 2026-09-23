import { z } from "zod";
import prisma from "@rw/db";
import { workspace as workspaceService } from "../services/account/index.js";
import { userRequired } from "./middleware.js";

const emptyInputSchema = z.object({});

/** The assignable containers — what the member-management UI offers. */
export const listBuckets = userRequired.input(emptyInputSchema).handler(async ({ context }) => {
  context.access.requireSomewhere("ADMIN");
  const { workspaceId } = context.current;

  const buckets = await prisma.bucket.findMany({
    where: { workspaceId },
    select: { id: true, kind: true, siteId: true, workcenterId: true, name: true },
    orderBy: [{ siteId: "asc" }, { kind: "asc" }, { name: "asc" }],
  });
  return { data: buckets };
});

export const listMembers = userRequired.input(emptyInputSchema).handler(async ({ context }) => {
  context.access.requireSomewhere("ADMIN");

  return { data: await workspaceService.listMembers(context.current.workspaceId) };
});
