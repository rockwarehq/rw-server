import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@rw/db";
import { logEvent } from "@rw/services/audit/index";
import { z } from "zod";

import { applySetup, SetupApplyError } from "../setup/apply.js";
import { planSetup, type SetupPlan } from "../setup/plan.js";
import { type SetupSpec, setupSpecSchema } from "../setup/spec.js";
import { userRequired } from "./middleware.js";
import type { CallerContext } from "./context.js";

// Setup changesets: a batch of master-data upserts (materials, products)
// keyed by another system's keys. Anyone with MANAGE at the plant may
// propose one, by hand or through a connected agent; it is planned against
// the plant and kept as a draft. Applying happens in IMM, by a person with
// the access every row needs, in one transaction. A connected agent can
// propose, replan and discard its person's drafts, never apply.

type UserContext = CallerContext<"user">;

function plan(row: { planResult: unknown }): SetupPlan {
  return row.planResult as unknown as SetupPlan;
}

function summarize(planned: SetupPlan) {
  return { ...planned.summary, applicable: planned.applicable, issues: planned.issues.length };
}

async function load(id: string) {
  const row = await prisma.setupChangeset.findUnique({ where: { id } });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Changeset not found" });
  return row;
}

/** A connected agent touches only drafts its own person proposed. */
function requireOwnDraftForAgent(row: { createdById: string | null }, context: UserContext) {
  if (context.current.via && row.createdById !== context.current.user.id) {
    throw new ORPCError("FORBIDDEN", { message: "An agent can only change its own person's changesets" });
  }
}

function requireDraft(row: { status: string }) {
  if (row.status !== "DRAFT")
    throw new ORPCError("CONFLICT", { message: `This changeset is already ${row.status.toLowerCase()}` });
}

const person = { select: { id: true, firstName: true, lastName: true, email: true, systemRole: true } } as const;

function personName(p: { firstName: string | null; lastName: string | null; email: string } | null) {
  if (!p) return null;
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email;
}

function upToDate(plan: SetupPlan) {
  return plan.applicable && plan.rows.every((row) => row.action === "unchanged");
}

export const create = userRequired
  .input(z.object({ siteId: z.uuid(), title: z.string().trim().min(1).max(200), spec: setupSpecSchema }))
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { site: input.siteId });
    const planned = await planSetup(prisma, input.siteId, input.spec);
    // Nothing to apply and nothing wrong: there's nothing for a person to review.
    if (upToDate(planned)) return { id: null, plan: planned };
    const via = context.current.via;
    const row = await prisma.setupChangeset.create({
      data: {
        siteId: input.siteId,
        title: input.title,
        source: input.spec.source,
        author: via ? "AGENT" : "USER",
        spec: input.spec as unknown as Prisma.InputJsonValue,
        planResult: planned as unknown as Prisma.InputJsonValue,
        summary: summarize(planned) as unknown as Prisma.InputJsonValue,
        grantId: via?.grantId ?? null,
        clientName: via?.clientName ?? null,
        createdById: context.current.user.id,
      },
      select: { id: true },
    });
    await logEvent({
      action: "SETUP_CHANGESET_PROPOSED",
      actorId: context.current.user.id,
      workspaceId: context.current.workspaceId,
      metadata: {
        changesetId: row.id,
        siteId: input.siteId,
        summary: planned.summary,
        ...(via ? { via: "mcp", grantId: via.grantId, clientName: via.clientName } : {}),
      },
    });
    return { id: row.id, plan: planned };
  });

export const list = userRequired
  .input(z.object({ siteId: z.uuid(), status: z.enum(["DRAFT", "APPLIED", "DISCARDED"]).optional() }))
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { site: input.siteId });
    const rows = await prisma.setupChangeset.findMany({
      where: { siteId: input.siteId, ...(input.status ? { status: input.status } : {}) },
      select: {
        id: true,
        title: true,
        source: true,
        status: true,
        author: true,
        clientName: true,
        summary: true,
        createdAt: true,
        appliedAt: true,
        createdBy: person,
        appliedBy: person,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((row) => ({
      ...row,
      createdBy: row.createdBy && {
        id: row.createdBy.id,
        name: personName(row.createdBy),
        staff: row.createdBy.systemRole !== null,
      },
      appliedBy: row.appliedBy && { id: row.appliedBy.id, name: personName(row.appliedBy) },
    }));
  });

export const get = userRequired.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  const row = await load(input.id);
  await context.access.require("VIEW", { site: row.siteId });
  const people = await prisma.setupChangeset.findUnique({
    where: { id: row.id },
    select: { createdBy: person, appliedBy: person },
  });
  return {
    id: row.id,
    siteId: row.siteId,
    title: row.title,
    source: row.source,
    status: row.status,
    author: row.author,
    clientName: row.clientName,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
    discardedAt: row.discardedAt,
    createdBy: people?.createdBy && {
      id: people.createdBy.id,
      name: personName(people.createdBy),
      staff: people.createdBy.systemRole !== null,
    },
    appliedBy: people?.appliedBy && { id: people.appliedBy.id, name: personName(people.appliedBy) },
    plan: plan(row),
    canApply: row.status === "DRAFT" && !context.current.via && context.access.can("MANAGE", { site: row.siteId }),
  };
});

export const replan = userRequired.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  const row = await load(input.id);
  await context.access.require("MANAGE", { site: row.siteId });
  requireOwnDraftForAgent(row, context);
  requireDraft(row);
  const planned = await planSetup(prisma, row.siteId, row.spec as unknown as SetupSpec);
  await prisma.setupChangeset.update({
    where: { id: row.id },
    data: {
      planResult: planned as unknown as Prisma.InputJsonValue,
      summary: summarize(planned) as unknown as Prisma.InputJsonValue,
    },
  });
  return { id: row.id, plan: planned };
});

export const discard = userRequired.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  const row = await load(input.id);
  await context.access.require("MANAGE", { site: row.siteId });
  requireOwnDraftForAgent(row, context);
  requireDraft(row);
  await prisma.setupChangeset.update({
    where: { id: row.id },
    data: { status: "DISCARDED", discardedAt: new Date() },
  });
  await logEvent({
    action: "SETUP_CHANGESET_DISCARDED",
    actorId: context.current.user.id,
    workspaceId: context.current.workspaceId,
    metadata: { changesetId: row.id, siteId: row.siteId },
  });
  return { ok: true };
});

// Never callable by a connected agent (not in AGENT_CALLABLE): a person
// applies, interactively, with MANAGE at the plant (what every v1 row needs:
// materials and products are plant records).
export const apply = userRequired.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  const row = await load(input.id);
  await context.access.require("MANAGE", { site: row.siteId });
  requireDraft(row);

  // Claim the draft first so two people applying at once can't both write.
  const claimed = await prisma.setupChangeset.updateMany({
    where: { id: row.id, status: "DRAFT" },
    data: { status: "APPLIED", appliedById: context.current.user.id, appliedAt: new Date() },
  });
  if (claimed.count === 0) throw new ORPCError("CONFLICT", { message: "This changeset was just applied or discarded" });

  try {
    const result = await applySetup({
      siteId: row.siteId,
      changesetId: row.id,
      spec: row.spec as unknown as SetupSpec,
      reviewedPlan: plan(row),
    });
    await logEvent({
      action: "SETUP_CHANGESET_APPLIED",
      actorId: context.current.user.id,
      userId: row.createdById ?? undefined,
      workspaceId: context.current.workspaceId,
      metadata: {
        changesetId: row.id,
        siteId: row.siteId,
        summary: result.plan.summary,
        // Applied by a person in IMM; the agent only proposed it.
        ...(row.grantId ? { proposedVia: "mcp", grantId: row.grantId, clientName: row.clientName } : {}),
      },
    });
    return { ok: true, written: result.written };
  } catch (err) {
    // Back to a draft, with the fresh plan when the plant moved.
    await prisma.setupChangeset.update({
      where: { id: row.id },
      data: {
        status: "DRAFT",
        appliedById: null,
        appliedAt: null,
        ...(err instanceof SetupApplyError && err.plan
          ? {
              planResult: err.plan as unknown as Prisma.InputJsonValue,
              summary: summarize(err.plan) as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    if (err instanceof SetupApplyError) {
      throw new ORPCError(err.code === "STALE" ? "CONFLICT" : "BAD_REQUEST", { message: err.message });
    }
    throw err;
  }
});
