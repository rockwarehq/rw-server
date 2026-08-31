import prisma, { Prisma } from "@rw/db";
import type { CallSeverity, CallSource } from "@rw/db";
import { actorSiteRoleId, roleAllowed } from "../../employee/actor-role.js";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";
import { publishCallEvent } from "./events.js";

const callInclude = {
  definition: { select: { id: true, name: true, severity: true } },
  station: { select: { id: true, name: true } },
  openedByEmployee: { select: { id: true, version: { select: { firstName: true, lastName: true } } } },
  closedByEmployee: { select: { id: true, version: { select: { firstName: true, lastName: true } } } },
} as const;

type CallRecord = Prisma.CallGetPayload<{ include: typeof callInclude }>;
type ServiceError = { error: string; code: string };

export interface OpenCallInput {
  stationId: string;
  definitionId: string;
  source: CallSource;
  /** Programmatic origin discriminator, e.g. "station.down". */
  sourceType?: string;
  /** Free-form correlation id (alarm id, state-log id, ...). */
  sourceRef?: string;
  message?: string;
  /** Pre-resolved employee (display flows where the UI knows the operator). */
  openedByEmployeeId?: string;
  /** USER principal — resolved to an employee via WorkspaceMembership. */
  openedByUserId?: string;
}

export interface CloseCallInput {
  id: string;
  closeMessage?: string;
  closedByEmployeeId?: string;
  closedByUserId?: string;
  /** Set by the rpc layer for calls:admin principals — skips answer-role restrictions. */
  bypassAnswerRoles?: boolean;
}

export interface ListActiveCallsFilter {
  siteId?: string;
  workcenterId?: string;
  stationId?: string;
  definitionId?: string;
  severity?: CallSeverity;
  limit?: number;
  offset?: number;
}

export interface SearchCallsFilter {
  siteId: string;
  workcenterId?: string;
  stationId?: string;
  definitionId?: string;
  severity?: CallSeverity;
  source?: CallSource;
  status?: "open" | "closed" | "all";
  openedFrom?: Date;
  openedTo?: Date;
  sortBy?: "openedAt" | "closedAt" | "severity";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * Resolve who is acting. An explicit employeeId must exist in the workspace;
 * a userId resolves through their WorkspaceMembership.employee link, which
 * may legitimately be unset (unattributed action, not an error).
 */
async function resolveEmployee(
  workspaceId: string,
  employeeId?: string,
  userId?: string,
): Promise<{ employeeId: string | null; employeeVersionId: string | null } | { error: string; code: string }> {
  if (employeeId) {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, workspaceId: true, versionId: true },
    });
    if (!employee || employee.workspaceId !== workspaceId) {
      return { error: "Employee not found", code: "EMPLOYEE_NOT_FOUND" };
    }
    return { employeeId, employeeVersionId: employee.versionId };
  }
  if (userId) {
    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { employeeId: true, employee: { select: { versionId: true } } },
    });
    return {
      employeeId: membership?.employeeId ?? null,
      employeeVersionId: membership?.employee?.versionId ?? null,
    };
  }
  return { employeeId: null, employeeVersionId: null };
}

async function resolveShift(
  siteId: string,
  workcenterId: string | null,
  at: Date,
): Promise<{ id: string; businessDate: Date } | null> {
  const select = { id: true, businessDate: true } as const;
  if (workcenterId) {
    const scoped = await prisma.shiftInstance.findFirst({
      where: { siteId, workCenterId: workcenterId, startTime: { lte: at }, endTime: { gt: at } },
      select,
      orderBy: { startTime: "desc" },
    });
    if (scoped) return scoped;
  }
  return prisma.shiftInstance.findFirst({
    where: { siteId, workCenterId: null, startTime: { lte: at }, endTime: { gt: at } },
    select,
    orderBy: { startTime: "desc" },
  });
}

/**
 * BI dimension snapshots from the station's current job. Tool/product are
 * only set when the job has exactly one active tool/product — multi-tool or
 * multi-product jobs dimension through jobId instead.
 */
async function resolveJobDimensions(currentJobId: string | null) {
  const empty = {
    jobId: null,
    jobVersionId: null,
    toolId: null,
    toolVersionId: null,
    productId: null,
    productVersionId: null,
  };
  if (!currentJobId) return empty;
  const job = await prisma.job.findUnique({
    where: { id: currentJobId },
    select: {
      id: true,
      currentVersionId: true,
      tools: {
        where: { isActive: true, deletedAt: null },
        select: { toolId: true, tool: { select: { currentVersionId: true } } },
        take: 2,
      },
      jobProducts: {
        where: { deletedAt: null, currentVersion: { isActive: true } },
        select: { productId: true, product: { select: { currentVersionId: true } } },
        take: 2,
      },
    },
  });
  if (!job) return empty;
  const tool = job.tools.length === 1 ? job.tools[0] : null;
  const jobProduct = job.jobProducts.length === 1 ? job.jobProducts[0] : null;
  return {
    jobId: job.id,
    jobVersionId: job.currentVersionId,
    toolId: tool?.toolId ?? null,
    toolVersionId: tool?.tool.currentVersionId ?? null,
    productId: jobProduct?.productId ?? null,
    productVersionId: jobProduct?.product.currentVersionId ?? null,
  };
}

function emitLifecycleEvents(call: CallRecord, action: "opened" | "closed", workspaceId: string): void {
  publishCallEvent({
    action,
    callId: call.id,
    definitionId: call.definitionId,
    definitionName: call.definition.name,
    severity: call.severity,
    workspaceId,
    siteId: call.siteId,
    stationId: call.stationId,
    stationName: call.station.name,
    source: call.source,
    sourceType: call.sourceType ?? undefined,
    sourceRef: call.sourceRef ?? undefined,
    message: call.message ?? undefined,
    openedAt: call.openedAt.toISOString(),
    openedByEmployeeId: call.openedByEmployeeId ?? undefined,
    closedAt: call.closedAt?.toISOString(),
    closedByEmployeeId: call.closedByEmployeeId ?? undefined,
    closeMessage: call.closeMessage ?? undefined,
  });
  publishEntityEvent({
    action: action === "opened" ? "created" : "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Call,
    entityId: call.id,
    siteId: call.siteId,
    workspaceId,
    ...(action === "closed" ? { changedFields: ["closedAt", "closedByEmployeeId", "closeMessage"] } : {}),
  });
}

function findOpenCall(stationId: string, definitionId: string): Promise<CallRecord | null> {
  return prisma.call.findFirst({
    where: { stationId, definitionId, closedAt: null, deletedAt: null },
    include: callInclude,
  });
}

/**
 * Open a call. This is also the programmatic entry point — automation sources
 * call it with source: "SYSTEM" and a sourceType/sourceRef.
 *
 * Idempotent: re-opening while an instance is active returns the existing
 * call with deduped: true. The partial unique index on
 * (stationId, definitionId) WHERE open backstops the race window.
 */
export async function open(input: OpenCallInput): Promise<ServiceError | { data: CallRecord; deduped: boolean }> {
  const definition = await prisma.callDefinition.findUnique({
    where: { id: input.definitionId },
    select: {
      id: true,
      name: true,
      severity: true,
      requireOpenMessage: true,
      openRoles: { select: { id: true } },
      archivedAt: true,
      siteId: true,
      site: { select: { workspaceId: true } },
    },
  });
  if (!definition || definition.archivedAt) {
    return { error: "Call definition not found", code: "DEFINITION_NOT_FOUND" };
  }

  // SYSTEM opens are exempt: an automation missing a message must not
  // silently fail to raise the call.
  if (input.source === "MANUAL" && definition.requireOpenMessage && !input.message?.trim()) {
    return { error: "A message is required when opening this call", code: "MESSAGE_REQUIRED" };
  }

  const station = await prisma.station.findUnique({
    where: { id: input.stationId },
    select: {
      id: true,
      name: true,
      siteId: true,
      workcenterId: true,
      currentJobId: true,
      currentVersionId: true,
      deletedAt: true,
    },
  });
  if (!station || station.deletedAt) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }
  if (station.siteId !== definition.siteId) {
    return { error: "Call definition and station belong to different sites", code: "SITE_MISMATCH" };
  }

  const resolved = await resolveEmployee(definition.site.workspaceId, input.openedByEmployeeId, input.openedByUserId);
  if ("error" in resolved) return resolved;

  // SYSTEM opens bypass: automations aren't employees and must not be blocked.
  if (input.source === "MANUAL" && definition.openRoles.length > 0) {
    const roleId = await actorSiteRoleId(resolved.employeeId, definition.siteId);
    if (
      !roleAllowed(
        roleId,
        definition.openRoles.map((r) => r.id),
      )
    ) {
      return { error: "Your role is not allowed to open this call", code: "OPEN_ROLE_RESTRICTED" };
    }
  }

  const existing = await findOpenCall(station.id, definition.id);
  if (existing) return { data: existing, deduped: true };

  const now = new Date();
  const shift = await resolveShift(station.siteId, station.workcenterId, now);
  const jobDims = await resolveJobDimensions(station.currentJobId);

  try {
    const call = await prisma.call.create({
      data: {
        siteId: station.siteId,
        stationId: station.id,
        definitionId: definition.id,
        severity: definition.severity,
        openedAt: now,
        source: input.source,
        sourceType: input.sourceType ?? null,
        sourceRef: input.sourceRef ?? null,
        message: input.message ?? null,
        openedByEmployeeId: resolved.employeeId,
        openedByEmployeeVersionId: resolved.employeeVersionId,
        workcenterId: station.workcenterId,
        stationVersionId: station.currentVersionId,
        ...jobDims,
        shiftInstanceId: shift?.id ?? null,
        businessDate: shift?.businessDate ?? null,
      },
      include: callInclude,
    });
    emitLifecycleEvents(call, "opened", definition.site.workspaceId);
    return { data: call, deduped: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Lost the race on the open-call unique index: another open won.
      const winner = await findOpenCall(station.id, definition.id);
      if (winner) return { data: winner, deduped: true };
      return { error: "Concurrent call update, retry", code: "INVALID_STATE" };
    }
    throw err;
  }
}

/**
 * Close (answer) a call. In v1 answering and closing are the same action.
 */
export async function close(input: CloseCallInput): Promise<ServiceError | { data: CallRecord }> {
  const call = await prisma.call.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      siteId: true,
      closedAt: true,
      deletedAt: true,
      site: { select: { workspaceId: true } },
      definition: { select: { answerRoles: { select: { id: true } } } },
    },
  });
  if (!call || call.deletedAt) {
    return { error: "Call not found", code: "CALL_NOT_FOUND" };
  }
  if (call.closedAt) {
    return { error: "Call is already closed", code: "INVALID_STATE" };
  }

  const resolved = await resolveEmployee(call.site.workspaceId, input.closedByEmployeeId, input.closedByUserId);
  if ("error" in resolved) return resolved;

  if (!input.bypassAnswerRoles && call.definition.answerRoles.length > 0) {
    const roleId = await actorSiteRoleId(resolved.employeeId, call.siteId);
    if (
      !roleAllowed(
        roleId,
        call.definition.answerRoles.map((r) => r.id),
      )
    ) {
      return { error: "Your role is not allowed to answer this call", code: "ANSWER_ROLE_RESTRICTED" };
    }
  }

  // Race-safe: only the update that observes the call still open wins.
  const result = await prisma.call.updateMany({
    where: { id: input.id, closedAt: null, deletedAt: null },
    data: {
      closedAt: new Date(),
      closedByEmployeeId: resolved.employeeId,
      closedByEmployeeVersionId: resolved.employeeVersionId,
      closeMessage: input.closeMessage ?? null,
    },
  });
  if (result.count === 0) {
    return { error: "Call is already closed", code: "INVALID_STATE" };
  }

  const closed = await prisma.call.findUniqueOrThrow({ where: { id: input.id }, include: callInclude });
  emitLifecycleEvents(closed, "closed", call.site.workspaceId);
  return { data: closed };
}

export async function getById(id: string) {
  const call = await prisma.call.findUnique({ where: { id }, include: callInclude });
  if (!call || call.deletedAt) {
    return null;
  }
  return { data: call };
}

export async function listActive(filter: ListActiveCallsFilter = {}) {
  const { siteId, workcenterId, stationId, definitionId, severity, limit = 100, offset = 0 } = filter;

  const where: Prisma.CallWhereInput = { closedAt: null, deletedAt: null };
  if (siteId) where.siteId = siteId;
  if (stationId) where.stationId = stationId;
  if (definitionId) where.definitionId = definitionId;
  if (severity) where.severity = severity;
  if (workcenterId) where.workcenterId = workcenterId;

  const [calls, total] = await Promise.all([
    prisma.call.findMany({
      where,
      include: callInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { openedAt: "desc" },
    }),
    prisma.call.count({ where }),
  ]);

  return { data: calls, total, limit: Number(limit), offset: Number(offset) };
}

export async function search(filter: SearchCallsFilter) {
  const {
    siteId,
    workcenterId,
    stationId,
    definitionId,
    severity,
    source,
    status = "all",
    openedFrom,
    openedTo,
    sortBy = "openedAt",
    sortDir = "desc",
    limit = 50,
    offset = 0,
  } = filter;

  const where: Prisma.CallWhereInput = { siteId, deletedAt: null };
  if (stationId) where.stationId = stationId;
  if (definitionId) where.definitionId = definitionId;
  if (severity) where.severity = severity;
  if (source) where.source = source;
  if (workcenterId) where.workcenterId = workcenterId;
  if (status === "open") where.closedAt = null;
  if (status === "closed") where.closedAt = { not: null };
  if (openedFrom || openedTo) {
    where.openedAt = {
      ...(openedFrom ? { gte: openedFrom } : {}),
      ...(openedTo ? { lte: openedTo } : {}),
    };
  }

  const [calls, total] = await Promise.all([
    prisma.call.findMany({
      where,
      include: callInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { [sortBy]: sortDir },
    }),
    prisma.call.count({ where }),
  ]);

  return { data: calls, total, limit: Number(limit), offset: Number(offset) };
}
