import prisma from "@rw/db";
import type { LabelFilterTarget } from "@rw/db";

// A station's filters: for each target kind (JOB, TOOL, STATUS_REASON,
// DISPOSITION_REASON) a station may hold one filter — a set of labels.
// An item passes the filter when it carries at least one of those labels.
// No filter row for a target = everything is eligible. Filters shape what
// pickers show AND what can be assigned (changeJob, downtime reason,
// scrap reason writes all check them).

export interface SetLabelFilterInput {
  stationId: string;
  target: LabelFilterTarget;
  /** The filter's labels. Empty or missing = remove the filter (no filtering). */
  labelIds?: string[] | null;
}

const filterInclude = {
  labels: { select: { id: true, name: true, color: true } },
} as const;

export async function setLabelFilter(input: SetLabelFilterInput) {
  const { stationId, target, labelIds } = input;

  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, siteId: true, deletedAt: true },
  });
  if (!station || station.deletedAt) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  if (!labelIds || labelIds.length === 0) {
    await prisma.labelFilter.deleteMany({ where: { stationId, target } });
    return { data: null };
  }

  const found = await prisma.label.count({ where: { id: { in: labelIds }, siteId: station.siteId } });
  if (found !== labelIds.length) {
    return { error: "One or more labels not found for this site", code: "LABEL_NOT_FOUND" };
  }

  const filter = await prisma.labelFilter.upsert({
    where: { stationId_target: { stationId, target } },
    create: { stationId, target, labels: { connect: labelIds.map((id) => ({ id })) } },
    update: { labels: { set: labelIds.map((id) => ({ id })) } },
    include: filterInclude,
  });
  return { data: filter };
}

export async function listLabelFilters(stationId: string) {
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, deletedAt: true },
  });
  if (!station || station.deletedAt) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }
  const filters = await prisma.labelFilter.findMany({
    where: { stationId },
    include: filterInclude,
    orderBy: { target: "asc" },
  });
  return { data: filters };
}

/**
 * The label ids of a station's filter for one target.
 * Returns null when the station has no filter for that target (= no filtering).
 */
export async function getFilterLabelIds(stationId: string, target: LabelFilterTarget): Promise<string[] | null> {
  const filter = await prisma.labelFilter.findUnique({
    where: { stationId_target: { stationId, target } },
    select: { labels: { select: { id: true } } },
  });
  // A filter with no labels (only possible via direct DB writes) means no
  // filtering — never "block everything".
  if (!filter || filter.labels.length === 0) return null;
  return filter.labels.map((l) => l.id);
}
