import prisma from "@rw/db";

/**
 * Where a tool is in use right now, and when it last was.
 *
 * A tool is in use when a station is running a job that uses it — the job
 * lists the tool (JobTool), or one of its product lines runs on it
 * (JobProduct.toolId). A station's run of a job is a StationJobLog row;
 * `endTime` null means it is running now. When no run is open, the tool has
 * been out of use since the latest `endTime` among those runs.
 */

export interface ToolUsageRun {
  stationId: string;
  stationName: string;
  jobId: string;
  jobName: string | null;
  since: Date;
}

export interface ToolUsage {
  /** Open runs of jobs that use the tool, earliest first. */
  running: ToolUsageRun[];
  /** When the most recent run using the tool ended; null if it never ran or is running. */
  lastUsedAt: Date | null;
}

interface RunRow {
  stationId: string;
  startTime: Date;
  endTime: Date | null;
  station: { name: string };
  jobId: string;
  job: { currentVersion: { name: string } | null };
}

/**
 * Pure: turns the open runs and the latest closed one into a ToolUsage.
 * A station appears once — if it somehow has two open runs of jobs using the
 * tool, the earlier start wins, since that is how long the tool has been there.
 */
export function summarizeUsage(open: RunRow[], lastClosed: { endTime: Date | null } | null): ToolUsage {
  const byStation = new Map<string, ToolUsageRun>();
  for (const row of [...open].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())) {
    if (byStation.has(row.stationId)) continue;
    byStation.set(row.stationId, {
      stationId: row.stationId,
      stationName: row.station.name,
      jobId: row.jobId,
      jobName: row.job.currentVersion?.name ?? null,
      since: row.startTime,
    });
  }
  const running = [...byStation.values()];
  return { running, lastUsedAt: running.length > 0 ? null : (lastClosed?.endTime ?? null) };
}

export async function usage(toolId: string) {
  const tool = await prisma.tool.findUnique({ where: { id: toolId }, select: { id: true, deletedAt: true } });
  if (!tool) return null;
  if (tool.deletedAt) return { error: "Tool has been deleted", code: "TOOL_DELETED" };

  const [listed, lines] = await Promise.all([
    prisma.jobTool.findMany({ where: { toolId }, select: { jobId: true } }),
    prisma.jobProduct.findMany({ where: { toolId, deletedAt: null }, select: { jobId: true } }),
  ]);
  const jobIds = [...new Set([...listed, ...lines].map((row) => row.jobId))];
  if (jobIds.length === 0) return { data: summarizeUsage([], null) };

  const select = {
    stationId: true,
    startTime: true,
    endTime: true,
    station: { select: { name: true } },
    jobId: true,
    job: { select: { currentVersion: { select: { name: true } } } },
  } as const;
  const [open, lastClosed] = await Promise.all([
    prisma.stationJobLog.findMany({
      where: { jobId: { in: jobIds }, endTime: null, station: { deletedAt: null } },
      select,
      orderBy: { startTime: "asc" },
    }),
    prisma.stationJobLog.findFirst({
      where: { jobId: { in: jobIds }, endTime: { not: null } },
      select: { endTime: true },
      orderBy: { endTime: "desc" },
    }),
  ]);
  return { data: summarizeUsage(open, lastClosed) };
}
