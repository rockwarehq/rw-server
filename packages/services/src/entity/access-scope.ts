import prisma, { type Prisma, type PrismaClient } from "@rw/db";

/** A proven production grant. Undefined workcenters means site-wide; [] means none. */
export interface ProductionReadScope {
  siteId: string;
  workspaceId: string;
  workcenterIds?: readonly string[];
}

export function stationReadWhere(scope: ProductionReadScope): Prisma.StationWhereInput {
  return {
    siteId: scope.siteId,
    ...(scope.workcenterIds ? { workcenterId: { in: [...scope.workcenterIds] } } : {}),
  };
}

export function ownsProductionResource(
  scope: ProductionReadScope,
  resource: { siteId: string; workcenterId?: string | null } | null,
): boolean {
  return (
    !!resource &&
    resource.siteId === scope.siteId &&
    (!scope.workcenterIds || (!!resource.workcenterId && scope.workcenterIds.includes(resource.workcenterId)))
  );
}

export function productionFactWhere(scope: ProductionReadScope) {
  return scope.workcenterIds ? { workcenterId: { in: [...scope.workcenterIds] } } : {};
}

export function metricPathInScope(scope: ProductionReadScope, path: string): boolean {
  if (!scope.workcenterIds) return true;
  const tokens = path.split(".");
  return (
    tokens[0] === "site" &&
    tokens[1] === scope.siteId &&
    tokens[2] === "workcenter" &&
    scope.workcenterIds.includes(tokens[3])
  );
}

/** Verify real ownership, including for a caller supplying a known foreign id. */
export async function canReadMetricEntity(
  scope: ProductionReadScope,
  entity: { entityType: string; entityId: string },
  db: PrismaClient = prisma,
): Promise<boolean> {
  switch (entity.entityType) {
    case "STATION":
      return ownsProductionResource(
        scope,
        await db.station.findUnique({
          where: { id: entity.entityId },
          select: { siteId: true, workcenterId: true },
        }),
      );
    case "WORKCENTER": {
      const row = await db.workcenter.findUnique({ where: { id: entity.entityId }, select: { siteId: true } });
      return ownsProductionResource(scope, row && { ...row, workcenterId: entity.entityId });
    }
    case "SITE":
      return !scope.workcenterIds && entity.entityId === scope.siteId;
    case "JOB": {
      // Job totals merge stations. Catalog access does not prove access to their inputs.
      if (scope.workcenterIds) return false;
      const row = await db.job.findUnique({ where: { id: entity.entityId }, select: { siteId: true } });
      return ownsProductionResource(scope, row);
    }
    default:
      return false;
  }
}

/** Existing bucket path is a persisted ownership stamp, not invented lineage. */
export async function metricReadWhere(scope: ProductionReadScope): Promise<{
  siteId: string;
  OR?: Array<{ path: { startsWith: string } | { equals: string } }>;
}> {
  if (!scope.workcenterIds) return { siteId: scope.siteId };
  return {
    siteId: scope.siteId,
    OR: scope.workcenterIds.flatMap((id) => [
      { path: { startsWith: `site.${scope.siteId}.workcenter.${id}.` } },
      { path: { equals: `site.${scope.siteId}.workcenter.${id}` } },
    ]),
  };
}

/** Raw points have datasource/site ownership, but no exclusive workcenter owner. */
export async function canReadPoint(scope: ProductionReadScope, pointId: string, db: PrismaClient = prisma) {
  if (scope.workcenterIds) return false;
  const point = await db.point.findUnique({
    where: { id: pointId },
    select: { datasource: { select: { siteId: true } } },
  });
  return point?.datasource.siteId === scope.siteId;
}
