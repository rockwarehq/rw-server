import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@rw/db";
import { logEvent } from "@rw/services/audit/index";
import { z } from "zod";

import { writeCount } from "../setup/apply.js";
import { clearImportData } from "../setup/clear.js";
import { SetupMappingError, setupFilesSchema, specFromFiles } from "../setup/mapping.js";
import { planSetup, type SetupPlan } from "../setup/plan.js";
import { MAX_INLINE_ROWS, type SetupSpec, setupSpecSchema, specRowCount } from "../setup/spec.js";
import { pageRows, planTotals, problemRows, type StoredOrigin, savePlan, withFileIssues } from "../setup/store.js";
import { pendingWhere } from "../setup/rollback.js";
import { claimApply, claimRollback, firstStep, runInBackground, type SetupProgress } from "../setup/runner.js";
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

/** What an import wrote, and what rolling it back did, for its page. */
async function journalSummary(changesetId: string) {
  const records = { in: ["material", "product"] };
  const [byAction, byOutcome, linksRemoved, toRollBack, toRemove, skipped] = await Promise.all([
    prisma.setupChangesetWrite.groupBy({
      by: ["action"],
      where: { changesetId, entity: { in: ["material", "product"] } },
      _count: { _all: true },
    }),
    prisma.setupChangesetWrite.groupBy({
      by: ["outcome"],
      where: { changesetId, entity: records, outcome: { not: null } },
      _count: { _all: true },
    }),
    prisma.setupChangesetWrite.count({ where: { changesetId, entity: "link", outcome: "removed" } }),
    prisma.setupChangesetWrite.count({ where: { ...pendingWhere(changesetId, "rollback"), entity: { not: "ref" } } }),
    prisma.setupChangesetWrite.count({ where: { ...pendingWhere(changesetId, "remove"), entity: { not: "ref" } } }),
    prisma.setupChangesetWrite.findMany({
      where: { changesetId, outcome: "skipped", entity: records },
      orderBy: { seq: "asc" },
      take: 50,
      select: { entity: true, key: true, label: true, reason: true },
    }),
  ]);
  const count = (list: Array<{ _count: { _all: number } } & Record<string, unknown>>, field: string, value: string) =>
    list.find((row) => row[field] === value)?._count._all ?? 0;
  return {
    created: count(byAction, "action", "create"),
    changed: count(byAction, "action", "update"),
    toRollBack,
    toRemove,
    /** Materials and products only; BOM lines are counted on their own. */
    outcomes: Object.fromEntries(byOutcome.map((row) => [row.outcome ?? "pending", row._count._all])),
    linksRemoved,
    skipped,
  };
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
    select: { createdBy: person, appliedBy: person, rolledBackBy: person },
  });
  const journal = await journalSummary(row.id);
  const manage = !context.current.via && context.access.can("MANAGE", { site: row.siteId });
  const admin = !context.current.via && context.access.can("ADMIN", { site: row.siteId });
  const running = row.status === "APPLYING" || row.status === "ROLLING_BACK";
  const settled = !running && !row.clearedAt;
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
    rolledBackAt: row.rolledBackAt,
    rolledBackBy: people?.rolledBackBy && { id: people.rolledBackBy.id, name: personName(people.rolledBackBy) },
    clearedAt: row.clearedAt,
    plan: planTotals(row),
    files: storedOrigin(row)?.files ?? [],
    writes: writeCount(planTotals(row)),
    progress: (row.progress as SetupProgress | null) ?? null,
    journal,
    canApply: row.status === "DRAFT" && !row.clearedAt && manage,
    canRollBack: settled && row.status !== "ROLLED_BACK" && journal.toRollBack > 0 && manage,
    canRemove: settled && journal.toRemove > 0 && admin,
    canClear: settled && ["APPLIED", "DISCARDED", "ROLLED_BACK"].includes(row.status) && manage,
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
// materials and products are plant records). The first chunk runs before
// this answers, so a small import is done, and a stale one refused, right
// away; a big one carries on in the background with its progress on the page.
export const apply = userRequired.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  const row = await load(input.id);
  await context.access.require("MANAGE", { site: row.siteId });
  requireDraft(row);
  if (row.clearedAt) throw new ORPCError("BAD_REQUEST", { message: "This import's data was cleared." });
  if (!planTotals(row).applicable) {
    throw new ORPCError("BAD_REQUEST", { message: "Resolve the changeset's problems before applying it." });
  }
  const total = await prisma.setupChangesetRow.count({ where: { changesetId: row.id } });
  // Claim the draft first so two people applying at once can't both write.
  if (!(await claimApply(row.id, context.current.user.id, total))) {
    throw new ORPCError("CONFLICT", { message: "This changeset was just applied or discarded" });
  }
  const first = await firstStep(row.id);
  if (first.kind === "stopped") {
    throw new ORPCError(first.error.code === "STALE" ? "CONFLICT" : "BAD_REQUEST", { message: first.error.message });
  }
  if (first.kind === "more") runInBackground(row.id);
  return { ok: true, status: first.kind === "done" ? ("APPLIED" as const) : ("APPLYING" as const) };
});

const rollbackInput = z.object({
  id: z.uuid(),
  mode: z
    .enum(["rollback", "remove"])
    .default("rollback")
    .describe("rollback: delete what it created, restore what it changed. remove: delete outright (plant ADMIN)"),
});

// Undo an import from its journal (setup/rollback.ts). Never agent-callable.
export const rollback = userRequired.input(rollbackInput).handler(async ({ input, context }) => {
  const row = await load(input.id);
  await context.access.require(input.mode === "remove" ? "ADMIN" : "MANAGE", { site: row.siteId });
  if (row.clearedAt) {
    throw new ORPCError("BAD_REQUEST", { message: "This import's data was cleared, so it can't be rolled back." });
  }
  const from =
    input.mode === "remove" ? ["APPLIED", "DRAFT", "DISCARDED", "ROLLED_BACK"] : ["APPLIED", "DRAFT", "DISCARDED"];
  if (!from.includes(row.status)) {
    throw new ORPCError("CONFLICT", { message: `This import is ${row.status.toLowerCase().replace("_", " ")}.` });
  }
  if (!(await claimRollback(row.id, context.current.user.id, input.mode, from))) {
    throw new ORPCError("CONFLICT", { message: "Something else just started on this import." });
  }
  const first = await firstStep(row.id);
  if (first.kind === "more") runInBackground(row.id);
  return { ok: true, status: first.kind === "done" ? ("ROLLED_BACK" as const) : ("ROLLING_BACK" as const) };
});

// Drop an import's spec, rows, files and journal; keep its record and audit.
export const clear = userRequired.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  const row = await load(input.id);
  await context.access.require("MANAGE", { site: row.siteId });
  if (row.clearedAt) return { ok: true };
  if (!["APPLIED", "DISCARDED", "ROLLED_BACK"].includes(row.status)) {
    throw new ORPCError("CONFLICT", { message: "Only an applied, discarded or rolled back import can be cleared." });
  }
  await clearImportData(row.id, context.current.user.id, context.current.workspaceId);
  return { ok: true };
});
