// Finds what the simulator can drive: every station with a livestore station
// node or an enabled imm.cycle_completed hook, the tag that hook watches, the
// tag properties on the node, and the station's
// effective standards for its current job. Re-polled so job, standard and
// profile changes reach the simulator without a restart.

import type { PrismaClient } from "@rw/db";
import { resolveEffectiveStandards } from "@rw/services/facility/station/effective-standards";

import type { TagRef } from "./config.js";
import type { CycleModeValue, Standards } from "./program.js";

export interface StationInfo {
  id: string;
  name: string;
  siteName: string;
  workspaceId: string;
  workcenterName: string | null;
  jobId: string | null;
  jobName: string | null;
  cycleMode: CycleModeValue;
  profileName: string | null;
  /** Null when the station has no job or no usable standard — can't pace it. */
  standards: Standards | null;
  /** The tag the station's cycle hook watches. */
  cycleTag: TagRef | null;
  /** Tag properties on the station's livestore node — what the simulator can publish to. */
  tagOptions: TagOption[];
  /** The datasource/gateway that owns the cycle tag, when its deviceId is a datasource. */
  cycleTagSource: { datasourceName: string; gatewayName: string | null } | null;
  /** Tag the hook reads the count from (count by time), when it is a tag. */
  quantityTag: TagRef | null;
  /** Open state-log status: UP / SLOW / FAST / DOWN, or null with no open entry. */
  status: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TagOption extends TagRef {
  propertyId: string;
  /** Property name on the station node, e.g. "Cycle Complete". */
  name: string;
}

interface PropertyRef {
  source?: { type?: string; propertyId?: string };
}

function propertyId(ref: unknown): string | null {
  const id = (ref as PropertyRef | undefined)?.source?.propertyId;
  return typeof id === "string" ? id : null;
}

export async function discoverStations(prisma: PrismaClient): Promise<StationInfo[]> {
  const hooks = await prisma.graphHook.findMany({
    where: { eventNamespace: "imm", eventName: "cycle_completed", enabled: true, isDeleted: false },
    select: { condition: true, eventContext: true },
  });

  const wanted = new Set<string>();
  const bindings = hooks.map((h) => {
    const ctx = (h.eventContext ?? {}) as Record<string, unknown>;
    const b = {
      trigger: propertyId(h.condition),
      station: propertyId(ctx.stationId),
      quantity: propertyId(ctx.quantity),
    };
    for (const id of [b.trigger, b.station, b.quantity]) if (id) wanted.add(id);
    return b;
  });

  const properties = await prisma.graphProperty.findMany({
    where: { id: { in: [...wanted] }, isDeleted: false },
    select: { id: true, nodeId: true, resolver: true },
  });
  const nodeOf = new Map(properties.map((p) => [p.id, p.nodeId]));
  const resolvers = new Map(properties.map((p) => [p.id, p.resolver as Record<string, unknown>]));
  const tagOf = (id: string | null): TagRef | null => {
    const r = id ? resolvers.get(id) : undefined;
    return r?.type === "tag" && typeof r.deviceId === "string" && typeof r.tagPath === "string"
      ? { deviceId: r.deviceId, tagPath: r.tagPath }
      : null;
  };

  const byStation = new Map<string, { nodeId: string | null; cycleTag: TagRef | null; quantityTag: TagRef | null }>();
  for (const b of bindings) {
    const r = b.station ? resolvers.get(b.station) : undefined;
    const stationId = r?.type === "entity" && typeof r.entityId === "string" ? r.entityId : null;
    if (!stationId || byStation.has(stationId)) continue;
    byStation.set(stationId, {
      nodeId: b.station ? (nodeOf.get(b.station) ?? null) : null,
      cycleTag: tagOf(b.trigger),
      quantityTag: tagOf(b.quantity),
    });
  }
  // Every @imm/station node is a candidate, hook or not — the tag picker can
  // point at any tag property on it. A hook only supplies the default tag.
  const stationNodes = await prisma.graphNode.findMany({
    where: { typeRef: "@imm/station", isDeleted: false },
    select: { id: true, typeContext: true },
  });
  for (const n of stationNodes) {
    const stationId = (n.typeContext as Record<string, unknown> | null)?.stationId;
    if (typeof stationId !== "string") continue;
    const known = byStation.get(stationId);
    if (!known) byStation.set(stationId, { nodeId: n.id, cycleTag: null, quantityTag: null });
    else if (!known.nodeId) known.nodeId = n.id;
  }
  if (byStation.size === 0) return [];

  const deviceIds = [...new Set([...byStation.values()].flatMap((b) => (b.cycleTag ? [b.cycleTag.deviceId] : [])))];
  const nodeIds = [...new Set([...byStation.values()].flatMap((b) => (b.nodeId ? [b.nodeId] : [])))];
  const [stations, openStates, datasources, nodeTags] = await Promise.all([
    prisma.station.findMany({
      where: { id: { in: [...byStation.keys()] }, deletedAt: null },
      select: {
        id: true,
        name: true,
        currentJobId: true,
        site: { select: { name: true, workspaceId: true } },
        workcenter: { select: { name: true } },
        currentVersion: { select: { cycleMode: true, profile: { select: { name: true } } } },
        currentJob: { select: { currentVersion: { select: { name: true } } } },
      },
    }),
    prisma.stationStateLog.findMany({
      where: { stationId: { in: [...byStation.keys()] }, endTime: null, deletedAt: null },
      select: { stationId: true, status: true },
    }),
    // Tag deviceIds are datasource ids when a gateway feeds them; anything else just won't match.
    prisma.datasource.findMany({
      where: { id: { in: deviceIds.filter((id) => UUID.test(id)) } },
      select: { id: true, name: true, gateway: { select: { name: true } } },
    }),
    prisma.graphProperty.findMany({
      where: { nodeId: { in: nodeIds }, resolverType: "tag", isDeleted: false },
      select: { id: true, nodeId: true, name: true, resolver: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const tagsByNode = new Map<string, TagOption[]>();
  for (const p of nodeTags) {
    const r = p.resolver as Record<string, unknown>;
    if (typeof r.deviceId !== "string" || typeof r.tagPath !== "string") continue;
    const list = tagsByNode.get(p.nodeId) ?? [];
    list.push({ propertyId: p.id, name: p.name, deviceId: r.deviceId, tagPath: r.tagPath });
    tagsByNode.set(p.nodeId, list);
  }
  const sourceOf = new Map(
    datasources.map((d) => [d.id, { datasourceName: d.name, gatewayName: d.gateway?.name ?? null }]),
  );
  const statusOf = new Map(openStates.map((s) => [s.stationId, s.status as string]));

  const infos = await Promise.all(
    stations.map(async (s): Promise<StationInfo> => {
      const cycleMode = (s.currentVersion?.cycleMode ?? "DISCRETE") as CycleModeValue;
      let standards: Standards | null = null;
      if (s.currentJobId) {
        const std = await resolveEffectiveStandards(prisma, s.id, s.currentJobId);
        if (std.standardCycleSeconds != null && std.standardCycleSeconds > 0) {
          standards = {
            mode: std.mode,
            standardCycleSeconds: std.standardCycleSeconds,
            standardQuantity: std.standardQuantity,
          };
        }
      }
      const binding = byStation.get(s.id);
      return {
        id: s.id,
        name: s.name,
        siteName: s.site?.name ?? "",
        workspaceId: s.site?.workspaceId ?? "",
        workcenterName: s.workcenter?.name ?? null,
        jobId: s.currentJobId,
        jobName: s.currentJob?.currentVersion?.name ?? null,
        cycleMode,
        profileName: s.currentVersion?.profile?.name ?? null,
        standards,
        cycleTag: binding?.cycleTag ?? null,
        tagOptions: binding?.nodeId ? (tagsByNode.get(binding.nodeId) ?? []) : [],
        cycleTagSource: binding?.cycleTag ? (sourceOf.get(binding.cycleTag.deviceId) ?? null) : null,
        quantityTag: binding?.quantityTag ?? null,
        status: statusOf.get(s.id) ?? null,
      };
    }),
  );
  return infos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
