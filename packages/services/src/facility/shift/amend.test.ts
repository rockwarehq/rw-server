import { describe, expect, it } from "vitest";
import { amendedRows, type ExistingRow, planInstanceDiff } from "./amend.js";
import type { InstanceRow, OverrideRule } from "./materialize.js";

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
const gap = (start: string, end: string) => row("Off Hours", start, end, { definitionId: null, isScheduled: false });
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
      `${g1.id}: Off Hours 11:00-14:00`,
    ]);
    expect(plan.creates).toEqual([]);
    expect(plan.obsolete).toEqual([]);
    // Both rows whole: the re-stamp and the bucket rebuild need the shift's
    // own hours, not just the hour that moved.
    expect(plan.window).toEqual({ start: t("06:00"), end: t("14:00") });
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
    expect(plan.window).toEqual({ start: t("12:00"), end: t("20:00") });
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
    expect(plan.updates.map((u) => `${u.id}: ${brief(u.after)}`)).toEqual([`${g1.id}: Off Hours 12:00-12:30`]);
    expect(plan.creates.map(brief)).toEqual(["OT 12:30-13:30", "Off Hours 13:30-14:00"]);
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

describe("amendedRows", () => {
  const s1 = row("Shift 1", "06:00", "12:00");
  const g1 = gap("12:00", "14:00");
  const s2 = row("Shift 2", "14:00", "20:00");
  const existing = [s1, g1, s2];
  const rule = (over: Partial<OverrideRule> = {}): OverrideRule => ({
    businessDate: day,
    shiftName: "Shift 1",
    startTime: null,
    endTime: null,
    isScheduled: null,
    note: null,
    ...over,
  });

  it("retimes the named row and re-cuts the Off Hours around it", () => {
    const rows = amendedRows(existing, rule({ startTime: t("07:00"), endTime: t("11:00") }), {
      kind: "change",
      rowId: s1.id,
    });
    expect(rows.map(brief)).toEqual(["Shift 1 07:00-11:00", "Off Hours 11:00-14:00", "Shift 2 14:00-20:00"]);
  });

  it("cancelling keeps the window and drops the shift out of scheduled time", () => {
    const rows = amendedRows(existing, rule({ shiftName: "Shift 2", isScheduled: false }), {
      kind: "change",
      rowId: s2.id,
    });
    expect(rows.map((r) => `${brief(r)} ${r.isScheduled}`)).toEqual([
      "Shift 1 06:00-12:00 true",
      "Off Hours 12:00-14:00 false",
      "Shift 2 14:00-20:00 false",
    ]);
  });

  it("builds from the rows alone, so a row outliving its assignment still amends", () => {
    const orphan = { ...row("Shift 1", "06:00", "12:00"), assignmentId: "ended-assignment" };
    const rows = amendedRows([orphan], rule({ startTime: t("06:00"), endTime: t("10:00") }), {
      kind: "change",
      rowId: orphan.id,
    });
    // The two hours it gave up stay covered, even with no row after it.
    expect(rows.map(brief)).toEqual(["Shift 1 06:00-10:00", "Off Hours 10:00-12:00"]);
  });

  it("adds a shift into Off Hours and re-cuts the gaps around it", () => {
    const added = {
      assignmentId: "asg",
      definitionId: null,
      siteId: "site",
      workCenterId: null,
      shiftName: "OT",
      businessDate: day,
      startTime: t("12:00"),
      endTime: t("13:00"),
      isScheduled: true,
    };
    const rows = amendedRows(existing, rule({ shiftName: "OT", startTime: t("12:00"), endTime: t("13:00") }), {
      kind: "add",
      row: added,
    });
    expect(rows.map(brief)).toEqual([
      "Shift 1 06:00-12:00",
      "OT 12:00-13:00",
      "Off Hours 13:00-14:00",
      "Shift 2 14:00-20:00",
    ]);
  });

  it("splitting a shift is a shorten then an add, and leaves no gap between the halves", () => {
    const shortened = amendedRows(
      existing,
      rule({ shiftName: "Shift 1", startTime: t("06:00"), endTime: t("09:00") }),
      {
        kind: "change",
        rowId: s1.id,
      },
    );
    expect(shortened.map(brief)).toEqual(["Shift 1 06:00-09:00", "Off Hours 09:00-14:00", "Shift 2 14:00-20:00"]);
    const asRows = shortened.map((r, i) => ({ ...r, id: `after-${i}` }));
    const added = {
      ...asRows[0],
      shiftName: "Shift 1B",
      definitionId: null,
      startTime: t("09:00"),
      endTime: t("12:00"),
    };
    const split = amendedRows(asRows, rule({ shiftName: "Shift 1B", startTime: t("09:00"), endTime: t("12:00") }), {
      kind: "add",
      row: added,
    });
    expect(split.map(brief)).toEqual([
      "Shift 1 06:00-09:00",
      "Shift 1B 09:00-12:00",
      "Off Hours 12:00-14:00",
      "Shift 2 14:00-20:00",
    ]);
  });

  it("removing an added shift gives the time back to Off Hours", () => {
    const withAdded = [...existing, { ...row("OT", "12:00", "13:00", { definitionId: null }), id: "added-1" }];
    const rows = amendedRows(withAdded, rule({ shiftName: "OT" }), { kind: "remove", rowId: "added-1" });
    expect(rows.map(brief)).toEqual(["Shift 1 06:00-12:00", "Off Hours 12:00-14:00", "Shift 2 14:00-20:00"]);
  });

  it("keeps rows of another assignment on a handover day and gaps between them", () => {
    const handover = { ...row("Shift 3", "20:00", "23:00"), assignmentId: "next-assignment" };
    const rows = amendedRows(
      [...existing, handover],
      rule({ shiftName: "Shift 2", startTime: t("14:00"), endTime: t("19:00") }),
      {
        kind: "change",
        rowId: s2.id,
      },
    );
    expect(rows.map(brief)).toEqual([
      "Shift 1 06:00-12:00",
      "Off Hours 12:00-14:00",
      "Shift 2 14:00-19:00",
      "Off Hours 19:00-20:00",
      "Shift 3 20:00-23:00",
    ]);
  });
});
