import prisma, { type Prisma } from "@rw/db";
import { logEvent } from "@rw/services/audit/index";
import { publishEntityEvent } from "@rw/services/entity/events";
import type { EntityEventInput } from "@rw/services/write";

import { moduleLogger } from "../logger.js";
import { APPLY_CHUNK, applyChunk, SetupApplyError } from "./apply.js";
import { clearImportData } from "./clear.js";
import { planSetup } from "./plan.js";
import { pendingWhere, type RollbackMode, rollbackChunk } from "./rollback.js";
import type { SetupSpec } from "./spec.js";
import { rowsFrom, type StoredOrigin, savePlan, withFileIssues } from "./store.js";

// Runs applies and rollbacks a chunk per transaction. The request that
// starts one runs the first chunk itself (so a small import applies, or a
// stale one is refused, before it answers); the rest runs here in the
// background. Each chunk renews a lease on the changeset; if the api stops,
// a sweep picks up any changeset whose lease ran out and carries on from
// its progress. Two runners can't both write a chunk: the second one's
// replan sees the first one's writes and stops as stale.

const log = moduleLogger("setup-runner");
const LEASE_MS = 2 * 60 * 1000;
const SWEEP_MS = 30 * 1000;
const CHUNK_TX = { timeout: 120_000, maxWait: 10_000 } as const;

export interface SetupProgress {
  phase: "apply" | RollbackMode;
  /** Rows (apply) or journal entries (rollback) done so far. */
  done: number;
  total: number;
  /** Records created or updated (apply). */
  written?: number;
  startedAt: string;
  /** Status to go back to if a rollback can't run. */
  previous?: string;
  /** Why an apply stopped before the end; the changeset is a draft again. */
  stopped?: { reason: "stale" | "failed"; message: string };
  /** A finished rollback's counts for materials and products, and BOM lines taken off. */
  outcomes?: Record<string, number>;
  linksRemoved?: number;
}

export type StepResult = { kind: "more" } | { kind: "done" } | { kind: "stopped"; error: SetupApplyError };

const leaseUntil = () => new Date(Date.now() + LEASE_MS);

function publish(events: EntityEventInput[]) {
  for (const event of events) publishEntityEvent(event);
}

async function workspaceOf(siteId: string) {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { workspaceId: true } });
  return site.workspaceId;
}

/** Start an apply: DRAFT → APPLYING. False when it isn't a draft any more. */
export async function claimApply(id: string, userId: string, totalRows: number): Promise<boolean> {
  const progress: SetupProgress = {
    phase: "apply",
    done: 0,
    total: totalRows,
    written: 0,
    startedAt: new Date().toISOString(),
  };
  const claimed = await prisma.setupChangeset.updateMany({
    where: { id, status: "DRAFT" },
    data: {
      status: "APPLYING",
      appliedById: userId,
      progress: progress as unknown as Prisma.InputJsonValue,
      leaseUntil: leaseUntil(),
    },
  });
  return claimed.count === 1;
}

/** Start a rollback or removal from any settled status. */
export async function claimRollback(id: string, userId: string, mode: RollbackMode, from: string[]) {
  const total = await prisma.setupChangesetWrite.count({ where: pendingWhere(id, mode) });
  const current = await prisma.setupChangeset.findUnique({ where: { id }, select: { status: true } });
  const progress: SetupProgress = {
    phase: mode,
    done: 0,
    total,
    startedAt: new Date().toISOString(),
    ...(current ? { previous: current.status } : {}),
  };
  const claimed = await prisma.setupChangeset.updateMany({
    where: { id, status: { in: from as never } },
    data: {
      status: "ROLLING_BACK",
      rolledBackById: userId,
      progress: progress as unknown as Prisma.InputJsonValue,
      leaseUntil: leaseUntil(),
    },
  });
  return claimed.count === 1;
}

async function stopApply(
  changeset: { id: string; siteId: string; spec: unknown; origin: unknown },
  progress: SetupProgress,
  error: SetupApplyError,
) {
  // A stale stop keeps a fresh plan of the whole import: the rows already
  // written now plan as unchanged, so checking it again and applying carries on.
  const fresh =
    error.code === "STALE" && changeset.spec
      ? withFileIssues(
          await planSetup(prisma, changeset.siteId, changeset.spec as SetupSpec),
          changeset.origin as StoredOrigin | null,
        )
      : null;
  await prisma.$transaction(async (tx) => {
    await tx.setupChangeset.update({
      where: { id: changeset.id },
      data: {
        status: "DRAFT",
        leaseUntil: null,
        progress: {
          ...progress,
          stopped: { reason: error.code === "STALE" ? "stale" : "failed", message: error.message },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    if (fresh) await savePlan(tx, changeset.id, fresh);
  }, CHUNK_TX);
}

async function stepApply(changeset: NonNullable<Awaited<ReturnType<typeof load>>>): Promise<StepResult> {
  const progress = changeset.progress as unknown as SetupProgress;
  const slice = await rowsFrom(prisma, changeset.id, progress.done, APPLY_CHUNK);
  if (slice.length === 0) {
    const appliedAt = new Date();
    await prisma.setupChangeset.update({
      where: { id: changeset.id },
      data: { status: "APPLIED", appliedAt, leaseUntil: null },
    });
    await logEvent({
      action: "SETUP_CHANGESET_APPLIED",
      actorId: changeset.appliedById ?? undefined,
      userId: changeset.createdById ?? undefined,
      workspaceId: await workspaceOf(changeset.siteId),
      metadata: {
        changesetId: changeset.id,
        siteId: changeset.siteId,
        summary: (changeset.planResult as { summary?: unknown } | null)?.summary ?? null,
        written: progress.written ?? 0,
        // Applied by a person in IMM; the agent only proposed it.
        ...(changeset.grantId
          ? { proposedVia: "mcp", grantId: changeset.grantId, clientName: changeset.clientName }
          : {}),
      },
    });
    return { kind: "done" };
  }
  if (!changeset.spec) {
    await stopApply(changeset, progress, new SetupApplyError("WRITE_FAILED", "This import's data was cleared."));
    return { kind: "stopped", error: new SetupApplyError("WRITE_FAILED", "This import's data was cleared.") };
  }
  const lastPosition = slice[slice.length - 1]?.position ?? progress.done;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const chunk = await applyChunk(tx, {
        changesetId: changeset.id,
        siteId: changeset.siteId,
        spec: changeset.spec as SetupSpec,
        rows: slice.map((s) => s.row),
      });
      const next: SetupProgress = {
        ...progress,
        done: lastPosition + 1,
        written: (progress.written ?? 0) + chunk.written,
      };
      await tx.setupChangeset.update({
        where: { id: changeset.id },
        data: { progress: next as unknown as Prisma.InputJsonValue, leaseUntil: leaseUntil() },
      });
      return chunk;
    }, CHUNK_TX);
    publish(result.events);
    return { kind: "more" };
  } catch (err) {
    const error =
      err instanceof SetupApplyError
        ? err
        : new SetupApplyError("WRITE_FAILED", err instanceof Error ? err.message : String(err));
    if (!(err instanceof SetupApplyError)) log.error({ err, changesetId: changeset.id }, "setup apply chunk failed");
    await stopApply(changeset, progress, error);
    return { kind: "stopped", error };
  }
}

async function stepRollback(changeset: NonNullable<Awaited<ReturnType<typeof load>>>): Promise<StepResult> {
  const progress = changeset.progress as unknown as SetupProgress;
  const mode: RollbackMode = progress.phase === "remove" ? "remove" : "rollback";
  const workspaceId = await workspaceOf(changeset.siteId);
  const result = await prisma.$transaction(async (tx) => {
    const chunk = await rollbackChunk(tx, { changesetId: changeset.id, siteId: changeset.siteId, workspaceId, mode });
    await tx.setupChangeset.update({
      where: { id: changeset.id },
      data: {
        progress: { ...progress, done: progress.done + chunk.settled } as unknown as Prisma.InputJsonValue,
        leaseUntil: leaseUntil(),
      },
    });
    return chunk;
  }, CHUNK_TX);
  publish(result.events);
  if (result.settled > 0) return { kind: "more" };

  // Final counts live on the changeset too: removing clears the journal they come from.
  const grouped = await prisma.setupChangesetWrite.groupBy({
    by: ["entity", "outcome"],
    where: { changesetId: changeset.id, entity: { not: "ref" } },
    _count: { _all: true },
  });
  const outcomes: Record<string, number> = {};
  let linksRemoved = 0;
  for (const row of grouped) {
    if (row.entity === "link") {
      if (row.outcome === "removed") linksRemoved += row._count._all;
      continue;
    }
    const key = row.outcome ?? "pending";
    outcomes[key] = (outcomes[key] ?? 0) + row._count._all;
  }
  await logEvent({
    action: "SETUP_CHANGESET_ROLLED_BACK",
    actorId: changeset.rolledBackById ?? undefined,
    userId: changeset.createdById ?? undefined,
    workspaceId,
    metadata: { changesetId: changeset.id, siteId: changeset.siteId, mode, outcomes, linksRemoved },
  });
  // Removing completely leaves nothing to roll back: drop the import's data, then settle.
  if (mode === "remove") await clearImportData(changeset.id, changeset.rolledBackById, workspaceId);
  await prisma.setupChangeset.update({
    where: { id: changeset.id },
    data: {
      status: "ROLLED_BACK",
      rolledBackAt: new Date(),
      leaseUntil: null,
      progress: { ...progress, outcomes, linksRemoved } as unknown as Prisma.InputJsonValue,
    },
  });
  return { kind: "done" };
}

function load(id: string) {
  return prisma.setupChangeset.findUnique({ where: { id } });
}

/**
 * The first chunk, for the request that starts a run: when that chunk was
 * the whole job, settle it here too, so a small import is done (and says so)
 * before the request answers.
 */
export async function firstStep(id: string): Promise<StepResult> {
  const result = await step(id);
  if (result.kind !== "more") return result;
  const after = await prisma.setupChangeset.findUnique({ where: { id }, select: { progress: true } });
  const progress = after?.progress as SetupProgress | null;
  return progress && progress.done >= progress.total ? step(id) : result;
}

/** Do one chunk of whatever the changeset is running. */
export async function step(id: string): Promise<StepResult> {
  const changeset = await load(id);
  if (!changeset) return { kind: "done" };
  if (changeset.status === "APPLYING") return stepApply(changeset);
  if (changeset.status === "ROLLING_BACK") return stepRollback(changeset);
  return { kind: "done" };
}

const running = new Set<string>();

/** Keep stepping until the changeset settles. One loop per changeset per process. */
export function runInBackground(id: string) {
  if (running.has(id)) return;
  running.add(id);
  void (async () => {
    try {
      while ((await step(id)).kind === "more") {
        // next chunk
      }
    } catch (err) {
      // The lease runs out and the sweep tries again.
      log.error({ err, changesetId: id }, "setup runner stopped");
    } finally {
      running.delete(id);
    }
  })();
}

/** Pick up applies and rollbacks whose runner went away (an api restart). */
async function sweep() {
  const orphaned = await prisma.setupChangeset.findMany({
    where: {
      status: { in: ["APPLYING", "ROLLING_BACK"] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    select: { id: true, leaseUntil: true },
    take: 20,
  });
  for (const row of orphaned) {
    if (running.has(row.id)) continue;
    const taken = await prisma.setupChangeset.updateMany({
      where: { id: row.id, leaseUntil: row.leaseUntil },
      data: { leaseUntil: leaseUntil() },
    });
    if (taken.count === 1) {
      log.info({ changesetId: row.id }, "resuming setup run");
      runInBackground(row.id);
    }
  }
}

export async function startSetupRunner(): Promise<() => Promise<void>> {
  const tick = () => void sweep().catch((err) => log.error({ err }, "setup sweep failed"));
  tick();
  const timer = setInterval(tick, SWEEP_MS);
  timer.unref();
  return async () => clearInterval(timer);
}
