import prisma from "@rw/db";
import { Prisma, type IntegrationRunStatus } from "@rw/db";

import type { IntegrationScope } from "./crud.js";

// IntegrationRun lifecycle, shared by the manual-execute RPC and the worker.

export interface StartRunInput {
  integrationId: string;
  actionKey: string;
  actionVersion: string;
  triggerType: string;
  triggerId?: string | null;
  input: Record<string, unknown>;
  dedupeKey?: string;
}

function errorResult(code: string, error: string) {
  return { error, code };
}

const runSelect = {
  id: true,
  integrationId: true,
  actionKey: true,
  actionVersion: true,
  status: true,
  triggerType: true,
  triggerId: true,
  input: true,
  result: true,
  error: true,
  dedupeKey: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
} as const;

/** Creates a PENDING run; a dedupeKey collision means a redelivered event, not an error to retry. */
export async function start(input: StartRunInput) {
  try {
    const run = await prisma.integrationRun.create({
      data: {
        integrationId: input.integrationId,
        actionKey: input.actionKey,
        actionVersion: input.actionVersion,
        triggerType: input.triggerType,
        triggerId: input.triggerId ?? null,
        input: input.input as Prisma.InputJsonValue,
        dedupeKey: input.dedupeKey ?? null,
      },
      select: runSelect,
    });
    return { data: run };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return errorResult("DUPLICATE_RUN", "A run for this dedupe key already exists");
    }
    throw err;
  }
}

export async function finish(
  id: string,
  outcome: { status: Extract<IntegrationRunStatus, "SUCCEEDED" | "FAILED">; result?: unknown; error?: string },
) {
  const started = await prisma.integrationRun.findUnique({ where: { id }, select: { startedAt: true } });
  const finishedAt = new Date();
  const run = await prisma.integrationRun.update({
    where: { id },
    data: {
      status: outcome.status,
      result: outcome.result === undefined ? Prisma.DbNull : (outcome.result as Prisma.InputJsonValue),
      error: outcome.error ?? null,
      finishedAt,
      durationMs: started ? finishedAt.getTime() - started.startedAt.getTime() : null,
    },
    select: runSelect,
  });
  return { data: run };
}

export interface ListRunsFilter {
  integrationId?: string;
  status?: IntegrationRunStatus;
  triggerType?: string;
  limit?: number;
  offset?: number;
}

export async function list(filter: ListRunsFilter, scope: IntegrationScope) {
  const { integrationId, status, triggerType, limit = 50, offset = 0 } = filter;
  const where = {
    integration: { siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
    ...(integrationId ? { integrationId } : {}),
    ...(status ? { status } : {}),
    ...(triggerType ? { triggerType } : {}),
  };

  const [data, total] = await Promise.all([
    prisma.integrationRun.findMany({
      where,
      select: runSelect,
      take: limit > 0 ? limit : undefined,
      skip: offset,
      orderBy: { startedAt: "desc" },
    }),
    prisma.integrationRun.count({ where }),
  ]);

  return { data, total, limit, offset };
}
