import { z } from "zod";
import prisma from "@rw/db";
import { workspace as workspaceService } from "../services/account/index.js";
import { authRequired } from "./middleware.js";
import { authorize } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";

const emptyInputSchema = z.object({});

/** The assignable containers — what the member-management UI offers. */
export const listBuckets = authRequired.input(emptyInputSchema).handler(async ({ context }) => {
  const { workspaceId } = grant(await authorize(context.iam, { tier: "ADMIN", scope: { kind: "anySite" } }));

  const buckets = await prisma.bucket.findMany({
    where: { workspaceId },
    select: { id: true, kind: true, siteId: true, workcenterId: true, name: true },
    orderBy: [{ siteId: "asc" }, { kind: "asc" }, { name: "asc" }],
  });
  return { data: buckets };
});

export const listMembers = authRequired.input(emptyInputSchema).handler(async ({ context }) => {
  const { workspaceId } = grant(await authorize(context.iam, { tier: "ADMIN", scope: { kind: "anySite" } }));

  return { data: await workspaceService.listMembers(workspaceId) };
});
