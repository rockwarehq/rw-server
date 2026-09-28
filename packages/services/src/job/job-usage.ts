import prisma from "@rw/db";
import { summarizeUsage } from "./tool-usage.js";

/**
 * Where a job is running right now, and when it last ran.
 *
 * A station's run of a job is a StationJobLog row; `endTime` null means it is
 * running now. The shape is the tool's (`ToolUsage`): each station running
 * the job once, earliest first, and — only when nothing is running — when
 * the latest run ended. `jobId`/`jobName` on each run are this job.
 */
export async function usage(jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true, deletedAt: true } });
  if (!job) return null;
  if (job.deletedAt) return { error: "Job has been deleted", code: "JOB_DELETED" };

  const [open, lastClosed] = await Promise.all([
    prisma.stationJobLog.findMany({
      where: { jobId, endTime: null, station: { deletedAt: null } },
      select: {
        stationId: true,
        startTime: true,
        endTime: true,
        station: { select: { name: true } },
        jobId: true,
        job: { select: { currentVersion: { select: { name: true } } } },
      },
      orderBy: { startTime: "asc" },
    }),
    prisma.stationJobLog.findFirst({
      where: { jobId, endTime: { not: null } },
      select: { endTime: true },
      orderBy: { endTime: "desc" },
    }),
  ]);
  return { data: summarizeUsage(open, lastClosed) };
}
