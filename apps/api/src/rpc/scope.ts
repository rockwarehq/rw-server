import type { Current } from "@rw/auth/context";
import { AccessDenied, type Access, type Target, type Level } from "@rw/auth/iam/access";
import type { SitelessRowKind } from "@rw/auth/iam/rows";

/**
 * Check access, then return the `{ workspaceId, siteId }` pair that the
 * livestore graph API (and integration services) take as their scope.
 * Site-less row kinds are not allowed here: these scopes always need a site.
 */
export async function workspaceSiteScope<T extends Target>(
  context: { current: Current; access: Access },
  level: Level,
  target: T & { [K in SitelessRowKind]?: never },
): Promise<{ workspaceId: string; siteId: string }> {
  const { siteId } = await context.access.require(level, target);
  return { workspaceId: context.current.workspaceId, siteId: siteId as string };
}

// ── Floor data (cycles, downtime, metrics, recaps) ─────────────────────────
//
// Floor data belongs to the workcenter that made it, even when a screen
// shows the whole plant. These two checks keep crew inside their cells.

const floorDenied = () => new AccessDenied("FORBIDDEN", "Requires VIEW access here");

/** Check a floor row is readable and lives at `siteId`. */
async function requireFloorRow(access: Access, siteId: string, target: { station: string } | { workcenter: string }) {
  const located = await access.require("VIEW", target);
  if (located.siteId !== siteId) throw floorDenied();
}

/**
 * For log searches that take an optional station or workcenter filter.
 * A named station or workcenter is checked. With neither, callers who see
 * the whole floor get the whole plant; crew with one cell get that cell;
 * crew with several must pick one.
 */
export async function floorFilter(
  context: { access: Access },
  siteId: string,
  filter: { workCenterId?: string; stationId?: string },
): Promise<{ workCenterId?: string; stationId?: string }> {
  if (filter.stationId) await requireFloorRow(context.access, siteId, { station: filter.stationId });
  if (filter.workCenterId) await requireFloorRow(context.access, siteId, { workcenter: filter.workCenterId });
  if (filter.stationId || filter.workCenterId) return filter;

  const scope = context.access.list("VIEW", siteId, "WORKCENTER");
  if (!scope.workcenterIds) return filter;
  if (scope.workcenterIds.length === 1) return { workCenterId: scope.workcenterIds[0] };
  throw floorDenied();
}

/**
 * For metric and historian series named by entity. Station and workcenter
 * series are checked on their cell. Site and job series add up every cell,
 * so they need the whole floor.
 */
export async function requireFloorEntities(
  context: { access: Access },
  siteId: string,
  entities: ReadonlyArray<{ entityType: string; entityId: string }>,
): Promise<void> {
  for (const { entityType, entityId } of entities) {
    if (entityType === "STATION") await requireFloorRow(context.access, siteId, { station: entityId });
    else if (entityType === "WORKCENTER") await requireFloorRow(context.access, siteId, { workcenter: entityId });
    else {
      if (entityType === "SITE" && entityId !== siteId) throw floorDenied();
      if (entityType === "JOB" && (await context.access.require("VIEW", { job: entityId })).siteId !== siteId)
        throw floorDenied();
      if (context.access.list("VIEW", siteId, "WORKCENTER").workcenterIds) throw floorDenied();
    }
  }
}
