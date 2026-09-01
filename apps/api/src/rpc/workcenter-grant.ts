import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { workcenterGrants } from "@rw/auth/iam/index";
import { SystemUserAssignmentError } from "@rw/auth/iam/assignments";
import { authRequired } from "./middleware.js";
import { authorize } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";

// Workcenter grants: GitHub-collaborator-style READ/WRITE access to one
// workcenter, managed by plant admins. The workcenter resolver proves the
// siteId, so a site-scoped user:admin (Plant Admin) manages exactly their
// own plant's workcenters; Company Administrator passes everywhere.

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  userId: z.uuid().optional(),
});

const upsertInputSchema = z.object({
  userId: z.uuid(),
  workcenterId: z.uuid(),
  access: z.enum(["READ", "WRITE"]),
});

const removeInputSchema = z.object({
  userId: z.uuid(),
  workcenterId: z.uuid(),
});

export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const { workspaceId } = grant(await authorize(context.iam, { permission: "user:read", scope: { kind: "anySite" } }));

  const rows = input.userId
    ? await workcenterGrants.listForUser(input.userId, workspaceId)
    : await workcenterGrants.listForWorkspace(workspaceId, input.siteId);
  return { data: rows };
});

export const upsert = authRequired.input(upsertInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "user:admin", scope: { kind: "workcenter", id: input.workcenterId } }),
  );

  try {
    return await workcenterGrants.upsertGrant(input);
  } catch (err) {
    throw mapGrantError(err);
  }
});

export const remove = authRequired.input(removeInputSchema).handler(async ({ input, context }) => {
  grant(
    await authorize(context.iam, { permission: "user:admin", scope: { kind: "workcenter", id: input.workcenterId } }),
  );

  await workcenterGrants.removeGrant(input);
  return { success: true };
});

function mapGrantError(err: unknown): Error {
  if (err instanceof SystemUserAssignmentError) {
    return new ORPCError("BAD_REQUEST", { message: err.message });
  }
  if (err instanceof Error && err.message.endsWith("not found")) {
    return new ORPCError("NOT_FOUND", { message: err.message });
  }
  return err instanceof Error ? err : new Error(String(err));
}
