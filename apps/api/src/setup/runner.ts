import prisma, { type Prisma } from "@rw/db";
import { auditContext, logEvent, runWithAuditContext } from "@rw/services/audit/index";
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
//
// A rollback chunk that fails as a whole (a timeout, the database going away;
// one entry failing is handled inside the chunk) is tried again by the sweep,
// up to ROLLBACK_ATTEMPTS times, then the rollback settles as stopped. Each
// chunk is its own transaction, so what earlier chunks undid stays undone and
// rolling back again carries on from there.

const log = moduleLogger("setup-runner");
const LEASE_MS = 2 * 60 * 1000;
const SWEEP_MS = 30 * 1000;
const CHUNK_TX = { timeout: 120_000, maxWait: 10_000 } as const;
/** Tries at one rollback chunk before the rollback stops. */
export const ROLLBACK_ATTEMPTS = 3;

export interface SetupProgress {
  phase: "apply" | RollbackMode;
  /** Rows (apply) or journal entries (rollback) done so far. */
  done: number;
  total: number;
  /** Records created or updated (apply). */
  written?: number;
  startedAt: string;
  /**
   * Why an apply stopped before the end (the changeset is a draft again), or
   * why a rollback did (ROLLBACK_STOPPED).
   */
  stopped?: { reason: "stale" | "failed"; message: string };
  /** Failed tries at the current rollback chunk, and the last error. */
  attempts?: number;
  lastError?: string;
  /** A finished rollback's counts for materials and products, and BOM lines taken off. */
  outcomes?: Record<string, number>;
  linksRemoved?: number;
}

export type StepResult =
  | { kind: "more" }
  | { kind: "done" }
  | { kind: "stopped"; error: SetupApplyError }
  // A rollback chunk failed; the sweep tries it again.
  | { kind: "paused" };

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
  const progress: SetupProgress = {
    phase: mode,
    done: 0,
    total,
    startedAt: new Date().toISOString(),
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
  if (claimed.count !== 1) return false;
  // Entries an earlier run couldn't undo get another go.
  await prisma.setupChangesetWrite.updateMany({
    where: { changesetId: id, outcome: "failed" },
    data: { outcome: null, reason: null },
  });
  return true;
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
    await stopApply(changeset, progress, new SetupApplyError("WRITE_FAILED", "This import's files were cleaned up."));
    return { kind: "stopped", error: new SetupApplyError("WRITE_FAILED", "This import's files were cleaned up.") };
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
  let result: Awaited<ReturnType<typeof rollbackChunk>>;
  try {
    result = await prisma.$transaction(async (tx) => {
      const chunk = await rollbackChunk(tx, { changesetId: changeset.id, siteId: changeset.siteId, workspaceId, mode });
      const next: SetupProgress = { ...progress, done: progress.done + chunk.settled };
      delete next.attempts;
      delete next.lastError;
      await tx.setupChangeset.update({
        where: { id: changeset.id },
        data: { progress: next as unknown as Prisma.InputJsonValue, leaseUntil: leaseUntil() },
      });
      return chunk;
    }, CHUNK_TX);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (progress.attempts ?? 0) + 1;
    log.error({ err, changesetId: changeset.id, attempts }, "setup rollback chunk failed");
    if (attempts < ROLLBACK_ATTEMPTS) {
      // Let the lease lapse now: the sweep tries again on its next tick.
      await prisma.setupChangeset.update({
        where: { id: changeset.id },
        data: {
          progress: { ...progress, attempts, lastError: message } as unknown as Prisma.InputJsonValue,
          leaseUntil: new Date(),
        },
      });
      return { kind: "paused" };
    }
    await settleRollback(changeset, progress, mode, workspaceId, message);
    return { kind: "done" };
  }
  publish(result.events);
  if (result.settled > 0) return { kind: "more" };
  await settleRollback(changeset, progress, mode, workspaceId, null);
  return { kind: "done" };
}

/**
 * Finish a rollback: ROLLED_BACK when every entry was settled, else
 * ROLLBACK_STOPPED (entries failed, or `stoppedBy` a chunk that kept failing),
 * which keeps the journal so rolling back again can carry on.
 */
async function settleRollback(
  changeset: NonNullable<Awaited<ReturnType<typeof load>>>,
  progress: SetupProgress,
  mode: RollbackMode,
  workspaceId: string,
  stoppedBy: string | null,
) {
  // Final counts live on the changeset too: removing clears the journal they come from.
  const grouped = await prisma.setupChangesetWrite.groupBy({
    by: ["entity", "outcome"],
    where: { changesetId: changeset.id },
    _count: { _all: true },
  });
  const outcomes: Record<string, number> = {};
  let linksRemoved = 0;
  let failed = 0;
  for (const row of grouped) {
    if (row.outcome === "failed") failed += row._count._all;
    if (row.entity === "ref") continue;
    if (row.entity === "link") {
      if (row.outcome === "removed") linksRemoved += row._count._all;
      continue;
    }
    const key = row.outcome ?? "pending";
    outcomes[key] = (outcomes[key] ?? 0) + row._count._all;
  }
  const stopped =
    stoppedBy !== null
      ? { reason: "failed" as const, message: stoppedBy }
      : failed > 0
        ? { reason: "failed" as const, message: `${failed} ${failed === 1 ? "entry" : "entries"} couldn't be undone.` }
        : null;
  await logEvent({
    action: "SETUP_CHANGESET_ROLLED_BACK",
    actorId: changeset.rolledBackById ?? undefined,
    userId: changeset.createdById ?? undefined,
    workspaceId,
    metadata: {
      changesetId: changeset.id,
      siteId: changeset.siteId,
      mode,
      outcomes,
      linksRemoved,
      ...(stopped ? { stopped: stopped.message } : {}),
    },
  });
  // Removing completely leaves nothing to roll back: drop the import's data, then settle.
  if (mode === "remove" && !stopped) await clearImportData(changeset.id, changeset.rolledBackById, workspaceId);
  const next: SetupProgress = { ...progress, outcomes, linksRemoved, ...(stopped ? { stopped } : {}) };
  delete next.attempts;
  delete next.lastError;
  await prisma.setupChangeset.update({
    where: { id: changeset.id },
    data: {
      status: stopped ? "ROLLBACK_STOPPED" : "ROLLED_BACK",
      ...(stopped ? {} : { rolledBackAt: new Date() }),
      leaseUntil: null,
      progress: next as unknown as Prisma.InputJsonValue,
    },
  });
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
  const run = () => {
    if (changeset.status === "APPLYING") return stepApply(changeset);
    if (changeset.status === "ROLLING_BACK") return stepRollback(changeset);
    return Promise.resolve<StepResult>({ kind: "done" });
  };
  const applying = changeset.status === "APPLYING";
  // Every change the run makes names the import it came from, and who
  // proposed it when that was an agent.
  const origin = {
    changesetId: changeset.id,
    title: changeset.title,
    ...(changeset.clientName ? { proposedVia: changeset.clientName } : {}),
    ...(applying ? {} : { undo: true }),
  };
  // The request that started the run already says who and from where. In the
  // background, the run speaks for the person who started it, and one id ties
  // together everything it wrote.
  const request = auditContext();
  if (request) return runWithAuditContext({ ...request, metadata: { ...request.metadata, origin } }, run);
  return runWithAuditContext(
    {
      requestId: `${applying ? "apply" : "rollback"}:${changeset.id}`,
      actor: {
        actorId: (applying ? changeset.appliedById : changeset.rolledBackById) ?? undefined,
        siteId: changeset.siteId,
        // Picked up after a restart: carried on by the system, for that person.
        via: "system",
      },
      metadata: { origin },
    },
    run,
  );
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
