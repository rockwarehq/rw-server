import { describe, expect, it } from "vitest";
import { type ExistingRow, planInstanceDiff } from "./amend.js";
import type { InstanceRow } from "./materialize.js";

const day = new Date("2026-09-14T00:00:00Z");
const t = (s: string) => new Date(`2026-09-14T${s}:00Z`);
let seq = 0;
const row = (
  shiftName: string,
  start: string,
  end: string,
  opts: { definitionId?: string | null; isScheduled?: boolean } = {},
): ExistingRow => ({
  id: `row-${++seq}`,
  assignmentId: "asg",
  definitionId: opts.definitionId === undefined ? `def-${shiftName}` : opts.definitionId,
  siteId: "site",
  workCenterId: null,
  shiftName,
  businessDate: day,
  startTime: t(start),
  endTime: t(end),
  isScheduled: opts.isScheduled ?? true,
});
const gap = (start: string, end: string) =>
  row("Not Scheduled", start, end, { definitionId: null, isScheduled: false });
const target = (r: ExistingRow): InstanceRow => {
  const { id: _id, ...rest } = r;
  return rest;
};
const brief = (r: InstanceRow) =>
  `${r.shiftName} ${r.startTime.toISOString().slice(11, 16)}-${r.endTime.toISOString().slice(11, 16)}`;

describe("planInstanceDiff", () => {
  const s1 = row("Shift 1", "06:00", "12:00");
  const g1 = gap("12:00", "14:00");
  const s2 = row("Shift 2", "14:00", "20:00");
  const existing = [s1, g1, s2];

  it("identical target → nothing to do", () => {
    const plan = planInstanceDiff(existing, existing.map(target));
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.obsolete).toEqual([]);
    expect(plan.window).toBeNull();
  });

  it("shortening a shift keeps its id and widens the gap after it", () => {
    const plan = planInstanceDiff(existing, [
      target({ ...s1, endTime: t("11:00") }),
      target({ ...g1, startTime: t("11:00") }),
      target(s2),
    ]);
    expect(plan.updates.map((u) => `${u.id}: ${brief(u.after)}`)).toEqual([
      `${s1.id}: Shift 1 06:00-11:00`,
      `${g1.id}: Not Scheduled 11:00-14:00`,
    ]);
    expect(plan.creates).toEqual([]);
    expect(plan.obsolete).toEqual([]);
    expect(plan.window).toEqual({ start: t("11:00"), end: t("12:00") }); // only the hour that moved
  });

  it("extending a shift over the whole gap removes the gap row", () => {
    const plan = planInstanceDiff(existing, [target({ ...s1, endTime: t("14:00") }), target(s2)]);
    expect(plan.updates.map((u) => u.id)).toEqual([s1.id]);
    expect(plan.obsolete.map((r) => r.id)).toEqual([g1.id]);
  });

  it("starting a shift earlier shrinks the gap before it", () => {
    const plan = planInstanceDiff(existing, [
      target(s1),
      target({ ...g1, endTime: t("13:00") }),
      target({ ...s2, startTime: t("13:00") }),
    ]);
    expect(plan.updates.map((u) => u.id).sort()).toEqual([g1.id, s2.id].sort());
    expect(plan.window).toEqual({ start: t("13:00"), end: t("14:00") });
  });

  it("adding a shift inside a gap splits the gap: one piece updated, one created", () => {
    const added = row("OT", "12:30", "13:30", { definitionId: null });
    const plan = planInstanceDiff(existing, [
      target(s1),
      target({ ...g1, endTime: t("12:30") }),
      target(added),
      target(gap("13:30", "14:00")),
      target(s2),
    ]);
    expect(plan.updates.map((u) => `${u.id}: ${brief(u.after)}`)).toEqual([`${g1.id}: Not Scheduled 12:00-12:30`]);
    expect(plan.creates.map(brief)).toEqual(["OT 12:30-13:30", "Not Scheduled 13:30-14:00"]);
  });

  it("cancelling keeps the window and flips the flag and name", () => {
    const plan = planInstanceDiff(existing, [
      target(s1),
      target(g1),
      target({ ...s2, shiftName: "Holiday", isScheduled: false }),
    ]);
    expect(plan.updates.map((u) => `${u.id}: ${brief(u.after)} ${u.after.isScheduled}`)).toEqual([
      `${s2.id}: Holiday 14:00-20:00 false`,
    ]);
  });

  it("edge gap rows the target does not cover are left alone", () => {
    const leading = gap("04:00", "06:00");
    const plan = planInstanceDiff([leading, ...existing], existing.map(target));
    expect(plan.obsolete).toEqual([]);
    expect(plan.window).toBeNull();
  });
});
