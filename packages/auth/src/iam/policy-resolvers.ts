import prisma from "@rw/db";

// Site derivation for resource-scoped authorization checks. Each resolver is
// a single indexed read of the denormalized siteId column — deliberately
// narrower than the service getById calls (which join full records) so the
// policy can decide before any data is fetched. Missing id => null.

export type ResolvableSiteRef =
  | { kind: "station"; stationId: string }
  | { kind: "workcenter"; workcenterId: string }
  | { kind: "stationStateLog"; entryId: string };

export async function resolveSiteRef(ref: ResolvableSiteRef): Promise<{ siteId: string } | null> {
  switch (ref.kind) {
    case "station": {
      const row = await prisma.station.findUnique({
        where: { id: ref.stationId },
        select: { siteId: true },
      });
      return row;
    }
    case "workcenter": {
      const row = await prisma.workcenter.findUnique({
        where: { id: ref.workcenterId },
        select: { siteId: true },
      });
      return row;
    }
    case "stationStateLog": {
      const row = await prisma.stationStateLog.findUnique({
        where: { id: ref.entryId },
        select: { station: { select: { siteId: true } } },
      });
      return row ? { siteId: row.station.siteId } : null;
    }
  }
}
