import prisma from "@rw/db";

/**
 * Run history for one automation: every AutomationRun it matched, newest first, with what its
 * actions did in that run. Read side of `createDbRunRecorder()` (./recorder.ts).
 *
 * A delayed action shows up twice: the matching run records it as SCHEDULED, and when the wait is
 * over the scheduler records the real outcome as its own run (also matched to the automation) for
 * the same event. `eventId` lets a client pair the two.
 */

export interface AutomationRunRow {
  runId: string;
  eventId: string;
  firedAt: Date;
  finishedAt: Date | null;
  status: "SUCCESS" | "FAILED" | "DROPPED";
  error: string | null;
  /** Why this automation matched but didn't act (e.g. "cooldown"); null when it acted. */
  skipped: string | null;
  payload: unknown;
  actions: {
    actionIdx: number;
    actionType: string;
    actionVersion: string;
    status: "SUCCESS" | "FAILED" | "SKIPPED" | "SCHEDULED";
    error: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  }[];
}

export async function listAutomationRuns(input: {
  automationId: string;
  limit: number;
  /** Only runs fired strictly before this instant: the page cursor (the oldest `firedAt` seen). */
  before?: Date;
}): Promise<{ data: AutomationRunRow[]; hasMore: boolean }> {
  const { automationId, limit, before } = input;
  const runs = await prisma.automationRun.findMany({
    where: {
      matches: { some: { automationId } },
      ...(before ? { firedAt: { lt: before } } : {}),
    },
    orderBy: [{ firedAt: "desc" }, { id: "desc" }],
    // One extra row says whether there is another page.
    take: limit + 1,
    select: {
      id: true,
      eventId: true,
      firedAt: true,
      finishedAt: true,
      status: true,
      error: true,
      payload: true,
      matches: { where: { automationId }, select: { skipped: true } },
      actionRuns: {
        where: { automationId },
        orderBy: [{ actionIdx: "asc" }, { startedAt: "asc" }],
        select: {
          actionIdx: true,
          actionType: true,
          actionVersion: true,
          status: true,
          error: true,
          startedAt: true,
          finishedAt: true,
        },
      },
    },
  });
  return {
    hasMore: runs.length > limit,
    data: runs.slice(0, limit).map((run) => ({
      runId: run.id,
      eventId: run.eventId,
      firedAt: run.firedAt,
      finishedAt: run.finishedAt,
      status: run.status,
      error: run.error,
      skipped: run.matches[0]?.skipped ?? null,
      payload: run.payload,
      actions: run.actionRuns,
    })),
  };
}
