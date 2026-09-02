import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { actorRoleAllowed, resolveEmployee } from "../../employee/actor-role.js";
import {
  acquireStationLock,
  loadStationMetricContext,
  publishStationModeMetricEvent,
  publishStationStatusEntityEvent,
  splitOpenStateEntryForModeChange,
} from "../station/state.js";

const logInclude = {
  mode: { select: { id: true, name: true, scrapAll: true } },
  startedByEmployee: { select: { id: true, version: { select: { firstName: true, lastName: true } } } },
  endedByEmployee: { select: { id: true, version: { select: { firstName: true, lastName: true } } } },
} as const;

type ServiceError = { error: string; code: string };
type ModeLogRecord = Prisma.StationModeLogGetPayload<{ include: typeof logInclude }>;

const MODE_ROLE_RESTRICTED: ServiceError = {
  error: "Your role is not allowed to change this production mode",
  code: "MODE_ROLE_RESTRICTED",
};

export interface ForceModeInput {
  stationId: string;
  modeId: string;
  /** Pre-resolved employee (display flows where the UI knows the operator). */
  employeeId?: string;
  /** USER principal — resolved to an employee via WorkspaceMembership. */
  userId?: string;
  /** Set by the rpc layer for modes:admin principals — skips role restrictions. */
  bypassRoles?: boolean;
}

export interface ClearModeInput {
  stationId: string;
  employeeId?: string;
  userId?: string;
  bypassRoles?: boolean;
}

export interface ListModeLogsFilter {
  stationId: string;
  limit?: number;
  offset?: number;
}

/** Live metric + entity.changes so dashboards and andon rules see the mode move. */
function publishModeChange(stationId: string, modeName: string | null, observedAt: Date): void {
  loadStationMetricContext(prisma, stationId)
    .then((ctx) => {
      if (!ctx) return;
      publishStationModeMetricEvent(ctx, modeName, observedAt);
      publishStationStatusEntityEvent(ctx, ["productionModeId", "productionMode", "productionModeStartAt"]);
    })
    .catch((err) => {
      console.error(`[production-mode] Failed to publish mode change for station ${stationId}:`, err);
    });
}

/**
 * Force a station into a production mode. Forcing while already forced
 * switches modes (closes the open log entry, opens a new one); forcing the
 * active mode again is a no-op. The open state-log row is split at the
 * boundary so state entries stay mode-homogeneous.
 */
export async function force(input: ForceModeInput): Promise<ServiceError | { data: ModeLogRecord }> {
  const mode = await prisma.productionMode.findUnique({
    where: { id: input.modeId },
    select: {
      id: true,
      name: true,
      siteId: true,
      archivedAt: true,
      roles: { select: { id: true } },
      site: { select: { workspaceId: true } },
    },
  });
  if (!mode || mode.archivedAt) {
    return { error: "Production mode not found", code: "MODE_NOT_FOUND" };
  }

  const station = await prisma.station.findUnique({
    where: { id: input.stationId },
    select: { id: true, siteId: true, deletedAt: true },
  });
  if (!station || station.deletedAt) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }
  if (station.siteId !== mode.siteId) {
    return { error: "Production mode and station belong to different sites", code: "SITE_MISMATCH" };
  }

  const resolved = await resolveEmployee(mode.site.workspaceId, input.employeeId, input.userId);
  if ("error" in resolved) return resolved;

  if (!input.bypassRoles && !(await actorRoleAllowed(resolved.employeeId, mode.siteId, mode.roles))) {
    return MODE_ROLE_RESTRICTED;
  }

  const now = new Date();
  const { entry, changed } = await prisma.$transaction(async (tx) => {
    await acquireStationLock(tx, station.id);

    const open = await tx.stationModeLog.findFirst({
      where: { stationId: station.id, endTime: null },
      include: logInclude,
    });
    if (open?.modeId === mode.id) {
      return { entry: open, changed: false };
    }

    if (open) {
      await tx.stationModeLog.update({
        where: { id: open.id },
        data: { endTime: now, endedByEmployeeId: resolved.employeeId },
      });
    }
    const created = await tx.stationModeLog.create({
      data: {
        siteId: mode.siteId,
        stationId: station.id,
        modeId: mode.id,
        startTime: now,
        startedByEmployeeId: resolved.employeeId,
      },
      include: logInclude,
    });
    await splitOpenStateEntryForModeChange(tx, station.id, now, mode.id);
    return { entry: created, changed: true };
  });

  if (changed) publishModeChange(station.id, mode.name, now);
  return { data: entry };
}

/** Clear the station's active mode. Clearing an already-clear station is a no-op. */
export async function clear(input: ClearModeInput): Promise<ServiceError | { data: ModeLogRecord | null }> {
  const station = await prisma.station.findUnique({
    where: { id: input.stationId },
    select: { id: true, siteId: true, deletedAt: true, site: { select: { workspaceId: true } } },
  });
  if (!station || station.deletedAt) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  const open = await prisma.stationModeLog.findFirst({
    where: { stationId: station.id, endTime: null },
    select: { id: true, mode: { select: { roles: { select: { id: true } } } } },
  });
  if (!open) return { data: null };

  const resolved = await resolveEmployee(station.site.workspaceId, input.employeeId, input.userId);
  if ("error" in resolved) return resolved;

  // Same role list gates entering and exiting the mode.
  if (!input.bypassRoles && !(await actorRoleAllowed(resolved.employeeId, station.siteId, open.mode.roles))) {
    return MODE_ROLE_RESTRICTED;
  }

  const now = new Date();
  const entry = await prisma.$transaction(async (tx) => {
    await acquireStationLock(tx, station.id);

    // Re-read under the lock: the entry may have been closed or switched.
    const current = await tx.stationModeLog.findFirst({ where: { stationId: station.id, endTime: null } });
    if (!current) return null;
    const closed = await tx.stationModeLog.update({
      where: { id: current.id },
      data: { endTime: now, endedByEmployeeId: resolved.employeeId },
      include: logInclude,
    });
    await splitOpenStateEntryForModeChange(tx, station.id, now, null);
    return closed;
  });

  if (entry) publishModeChange(station.id, null, now);
  return { data: entry };
}

/** Mode audit trail for a station, newest first. */
export async function listLogs(filter: ListModeLogsFilter) {
  const { stationId, limit = 50, offset = 0 } = filter;

  const where = { stationId };
  const [logs, total] = await Promise.all([
    prisma.stationModeLog.findMany({
      where,
      include: logInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { startTime: "desc" },
    }),
    prisma.stationModeLog.count({ where }),
  ]);

  return { data: logs, total, limit: Number(limit), offset: Number(offset) };
}
