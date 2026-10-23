import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@rw/db";
import { logEvent } from "@rw/services/audit/index";
import { z } from "zod";

import { applySetup, MAX_APPLY_ROWS, SetupApplyError, writeCount } from "../setup/apply.js";
import { SetupMappingError, setupFilesSchema, specFromFiles } from "../setup/mapping.js";
import { planSetup, type SetupPlan } from "../setup/plan.js";
import { MAX_INLINE_ROWS, type SetupSpec, setupSpecSchema, specRowCount } from "../setup/spec.js";
import {
  loadPlan,
  pageRows,
  planTotals,
  problemRows,
  type StoredOrigin,
  savePlan,
  withFileIssues,
} from "../setup/store.js";
import { createUpload, readUploads } from "../setup/uploads.js";
import { userRequired } from "./middleware.js";
import type { CallerContext } from "./context.js";

// Setup changesets: a batch of master-data upserts (materials, products)
// keyed by another system's keys. Anyone with MANAGE at the plant may
// propose one, by hand or through a connected agent: as an inline spec, or
// as uploaded files plus a column mapping for anything large. It is planned
// against the plant and kept as a draft, its plan stored row by row.
// Applying happens in IMM, by a person with the access every row needs, in
// one transaction. A connected agent can propose, replan and discard its
// person's drafts, never apply.

type UserContext = CallerContext<"user">;

/** What create and replan answer with: totals, plus the rows that need attention. */
function proposal(id: string | null, plan: SetupPlan) {
  const { rows: _rows, ...totals } = plan;
  return { id, plan: totals, problems: problemRows(plan), writes: writeCount(plan) };
}

function storedOrigin(row: { origin: unknown }): StoredOrigin | null {
  return (row.origin as StoredOrigin | null) ?? null;
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

const createInput = z
  .object({
    siteId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    spec: setupSpecSchema.optional().describe(`The rows themselves, for up to ${MAX_INLINE_ROWS} rows`),
    source: z.string().trim().min(1).max(100).optional().describe("With files: the source system's name, as in a spec"),
    files: setupFilesSchema.optional().describe("Uploaded files and how their columns map to fields"),
  })
  .refine((input) => (input.spec ? !input.files : !!input.files && !!input.source), {
    message: "Send either spec, or files with source",
  });

export const create = userRequired.input(createInput).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });

  let spec: SetupSpec;
  let origin: StoredOrigin | null = null;
  if (input.spec) {
    if (specRowCount(input.spec) > MAX_INLINE_ROWS) {
      throw new ORPCError("BAD_REQUEST", {
        message: `An inline spec takes up to ${MAX_INLINE_ROWS} rows. Upload the files instead and propose them with a column mapping.`,
      });
    }
    spec = input.spec;
  } else if (input.files && input.source) {
    const mapping = input.files;
    const ids = [mapping.materials?.upload, mapping.products?.upload, mapping.bom?.upload].filter(
      (id): id is string => !!id,
    );
    if (ids.length === 0) throw new ORPCError("BAD_REQUEST", { message: "Map at least one file." });
    const files = await readUploads(input.siteId, context.current.user.id, ids);
    try {
      const built = specFromFiles(input.source, mapping, files);
      spec = built.spec;
      origin = { ...built.origin, issues: built.issues };
    } catch (err) {
      if (err instanceof SetupMappingError) throw new ORPCError("BAD_REQUEST", { message: err.message });
      throw err;
    }
  } else {
    throw new ORPCError("BAD_REQUEST", { message: "Send either spec, or files with source" });
  }

  const planned = withFileIssues(await planSetup(prisma, input.siteId, spec), origin);
  // Nothing to apply and nothing wrong: there's nothing for a person to review.
  if (upToDate(planned)) return proposal(null, planned);

  const via = context.current.via;
  const id = await prisma.$transaction(
    async (tx) => {
      const row = await tx.setupChangeset.create({
        data: {
          siteId: input.siteId,
          title: input.title,
          source: spec.source,
          author: via ? "AGENT" : "USER",
          spec: spec as unknown as Prisma.InputJsonValue,
          planResult: {},
          summary: {},
          ...(input.files ? { mapping: input.files as unknown as Prisma.InputJsonValue } : {}),
          ...(origin ? { origin: origin as unknown as Prisma.InputJsonValue } : {}),
          grantId: via?.grantId ?? null,
          clientName: via?.clientName ?? null,
          createdById: context.current.user.id,
        },
        select: { id: true },
      });
      await savePlan(tx, row.id, planned);
      return row.id;
    },
    { timeout: 60_000 },
  );
  await logEvent({
    action: "SETUP_CHANGESET_PROPOSED",
    actorId: context.current.user.id,
    workspaceId: context.current.workspaceId,
    metadata: {
      changesetId: id,
      siteId: input.siteId,
      summary: planned.summary,
      ...(origin ? { files: origin.files } : {}),
      ...(via ? { via: "mcp", grantId: via.grantId, clientName: via.clientName } : {}),
    },
  });
  return proposal(id, planned);
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
    plan: planTotals(row),
    files: storedOrigin(row)?.files ?? [],
    writes: writeCount(planTotals(row)),
    maxApplyRows: MAX_APPLY_ROWS,
    canApply: row.status === "DRAFT" && !context.current.via && context.access.can("MANAGE", { site: row.siteId }),
  };
});

export const replan = userRequired.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  const row = await load(input.id);
  await context.access.require("MANAGE", { site: row.siteId });
  requireOwnDraftForAgent(row, context);
  requireDraft(row);
  const planned = withFileIssues(
    await planSetup(prisma, row.siteId, row.spec as unknown as SetupSpec),
    storedOrigin(row),
  );
  await prisma.$transaction((tx) => savePlan(tx, row.id, planned), { timeout: 60_000 });
  return proposal(row.id, planned);
});

const rowsInput = z.object({
  id: z.uuid(),
  action: z.enum(["create", "update", "unchanged", "conflict"]).optional(),
  entity: z.enum(["material", "product"]).optional(),
  q: z.string().trim().max(200).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
});

/** A page of a changeset's planned rows, filtered by action, entity or text. */
export const rows = userRequired.input(rowsInput).handler(async ({ input, context }) => {
  const row = await load(input.id);
  await context.access.require("VIEW", { site: row.siteId });
  const { id, ...query } = input;
  return pageRows(id, { ...query, q: query.q || undefined });
});

/** Start an upload: the file is then sent with the token (see setup/routes.ts). */
export const createUploadProcedure = userRequired
  .input(z.object({ siteId: z.uuid(), filename: z.string().trim().min(1).max(255) }))
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { site: input.siteId });
    const upload = await createUpload({
      siteId: input.siteId,
      filename: input.filename,
      createdById: context.current.user.id,
      grantId: context.current.via?.grantId ?? null,
    });
    return { ...upload, path: `/setup/uploads/${upload.id}` };
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
  const totals = planTotals(row);
  if (!totals.applicable) {
    throw new ORPCError("BAD_REQUEST", { message: "Resolve the changeset's problems before applying it." });
  }
  if (writeCount(totals) > MAX_APPLY_ROWS) {
    throw new ORPCError("BAD_REQUEST", {
      message: `This import writes ${writeCount(totals)} records; one apply takes up to ${MAX_APPLY_ROWS} for now. Split it into smaller imports.`,
    });
  }

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
      reviewedPlan: await loadPlan(prisma, row),
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
    await prisma.$transaction(
      async (tx) => {
        await tx.setupChangeset.update({
          where: { id: row.id },
          data: { status: "DRAFT", appliedById: null, appliedAt: null },
        });
        if (err instanceof SetupApplyError && err.plan) {
          await savePlan(tx, row.id, withFileIssues(err.plan, storedOrigin(row)));
        }
      },
      { timeout: 60_000 },
    );
    if (err instanceof SetupApplyError) {
      throw new ORPCError(err.code === "STALE" ? "CONFLICT" : "BAD_REQUEST", { message: err.message });
    }
    throw err;
  }
});
