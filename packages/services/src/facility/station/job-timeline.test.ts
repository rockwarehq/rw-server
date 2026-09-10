import { describe, expect, it } from "vitest";
import { type JobLogRow, planTimelineRewrite } from "./job-timeline.js";

const t = (h: number) => new Date(Date.UTC(2026, 8, 10, h));
const row = (id: string, jobId: string, start: number, end: number | null): JobLogRow => ({
  id,
  jobId,
  jobVersionId: `${jobId}v`,
  startTime: t(start),
  endTime: end === null ? null : t(end),
});
const J2 = { jobId: "J2", jobVersionId: "J2v" };

describe("planTimelineRewrite", () => {
  it("splits a straddling row and inserts the asserted job", () => {
    const plan = planTimelineRewrite([row("a", "J1", 0, 10)], t(4), t(6), J2);
    expect(plan.updates).toEqual([{ id: "a", startTime: t(0), endTime: t(4) }]);
    expect(plan.inserts).toEqual([
      { ...J2, startTime: t(4), endTime: t(6), copyOf: null },
      {
        jobId: "J1",
        jobVersionId: "J1v",
        startTime: t(6),
        endTime: t(10),
        copyOf: expect.objectContaining({ id: "a" }),
      },
    ]);
    expect(plan.deletes).toEqual([]);
  });

  it("trims the open row and opens the asserted job through now", () => {
    const plan = planTimelineRewrite([row("a", "J1", 0, null)], t(4), null, J2);
    expect(plan.updates).toEqual([{ id: "a", startTime: t(0), endTime: t(4) }]);
    expect(plan.inserts).toEqual([{ ...J2, startTime: t(4), endTime: null, copyOf: null }]);
  });

  it("deletes contained rows, trims overlapping ends, and merges same-job neighbours", () => {
    const rows = [row("a", "J1", 0, 3), row("b", "J3", 3, 5), row("c", "J2", 5, 8), row("d", "J2", 8, null)];
    const plan = planTimelineRewrite(rows, t(2), t(6), J2);
    expect(plan.updates).toEqual([
      { id: "a", startTime: t(0), endTime: t(2) },
      { id: "c", startTime: t(2), endTime: null },
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.deletes.sort()).toEqual(["b", "d"]);
  });

  it("extends a same-job row that ends exactly at the window start", () => {
    const plan = planTimelineRewrite([row("a", "J2", 0, 4), row("b", "J1", 4, 9)], t(4), t(9), J2);
    expect(plan.updates).toEqual([{ id: "a", startTime: t(0), endTime: t(9) }]);
    expect(plan.inserts).toEqual([]);
    expect(plan.deletes).toEqual(["b"]);
  });

  it("clears the window when no job is asserted", () => {
    const plan = planTimelineRewrite([row("a", "J1", 0, 10)], t(4), t(6), null);
    expect(plan.updates).toEqual([{ id: "a", startTime: t(0), endTime: t(4) }]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({ jobId: "J1", startTime: t(6), endTime: t(10) });
  });

  it("is a no-op when the timeline already matches", () => {
    const plan = planTimelineRewrite([row("a", "J1", 0, 4), row("b", "J2", 4, 8)], t(4), t(8), J2);
    expect(plan).toEqual({ updates: [], inserts: [], deletes: [] });
  });
});
