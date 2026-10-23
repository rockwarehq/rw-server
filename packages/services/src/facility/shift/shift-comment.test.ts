import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import * as comments from "./shift-comment.js";

// Integration tests (shift-signoff.test.ts conventions): require DATABASE_URL.
// Covers who a comment is attributed to — a signed-in user, or, from an
// operator terminal that has no user, the employee who wrote it.

describe.skipIf(!process.env.DATABASE_URL)("shiftComment authorship", () => {
  let siteId: string;
  let workcenterId: string;
  let stationId: string;
  let shiftInstanceId: string;
  let endedShiftInstanceId: string;
  let userId: string;
  let employeeId: string;
  let employeeVersionId: string;

  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  const createEmployee = async (workspaceId: string, firstName: string) => {
    const employee = await prisma.employee.create({ data: { workspaceId }, select: { id: true } });
    const version = await prisma.employeeVersion.create({
      data: { employeeId: employee.id, version: 1, firstName, lastName: "Operator" },
      select: { id: true },
    });
    await prisma.employee.update({ where: { id: employee.id }, data: { versionId: version.id } });
    return { employeeId: employee.id, versionId: version.id };
  };

  beforeAll(async () => {
    const suffix = randomUUID();
    // One workspace per deployment: use it.
    const workspace = await prisma.workspace.findFirstOrThrow();
    siteId = (await prisma.site.create({ data: { name: `Comments Site ${suffix}`, workspaceId: workspace.id } })).id;
    workcenterId = (await prisma.workcenter.create({ data: { name: `WC ${suffix}`, siteId } })).id;
    stationId = (await prisma.station.create({ data: { name: `STN ${suffix}`, siteId, workcenterId } })).id;

    const pattern = await prisma.shiftPattern.create({ data: { siteId, name: "P" } });
    const definition = await prisma.shiftDefinition.create({
      data: {
        patternId: pattern.id,
        dayOfRotation: 1,
        sortOrder: 1,
        startTime: "06:00",
        durationHrs: 8,
        shiftName: "S",
      },
    });
    const assignment = await prisma.shiftAssignment.create({
      data: { patternId: pattern.id, siteId, rotationStartDate: at(-48) },
    });
    shiftInstanceId = (
      await prisma.shiftInstance.create({
        data: {
          assignmentId: assignment.id,
          definitionId: definition.id,
          siteId,
          workCenterId: workcenterId,
          shiftName: "S",
          businessDate: at(-4),
          startTime: at(-4),
          endTime: at(4),
        },
      })
    ).id;

    endedShiftInstanceId = (
      await prisma.shiftInstance.create({
        data: {
          assignmentId: assignment.id,
          definitionId: definition.id,
          siteId,
          workCenterId: workcenterId,
          shiftName: "S",
          businessDate: at(-12),
          startTime: at(-12),
          endTime: at(-4),
        },
      })
    ).id;

    userId = (await prisma.user.create({ data: { email: `commenter-${suffix}@test.local`, passwordHash: "x" } })).id;

    ({ employeeId, versionId: employeeVersionId } = await createEmployee(workspace.id, "Floor"));
  });

  const base = () => ({ siteId, shiftInstanceId, workcenterId, stationId, text: "Hopper ran low at 10" });

  test("a terminal comment is attributed to the operator who wrote it", async () => {
    const result = await comments.create({ ...base(), createdById: null, createdByEmployeeId: employeeId });
    if ("error" in result) throw new Error(result.error);

    expect(result.data.createdBy).toBeNull();
    expect(result.data.createdByEmployee?.id).toBe(employeeId);
    expect(result.data.createdByEmployee?.version?.firstName).toBe("Floor");

    const row = await prisma.shiftComment.findUniqueOrThrow({ where: { id: result.data.id } });
    // Pinned to the version current when it was written, as calls are.
    expect(row.createdByEmployeeVersionId).toBe(employeeVersionId);
  });

  test("a terminal comment with no one named is refused", async () => {
    const result = await comments.create({ ...base(), createdById: null });
    expect("error" in result && result.code).toBe("EMPLOYEE_REQUIRED");
  });

  test("a signed-in user's comment keeps the user, with no employee when none is linked", async () => {
    const result = await comments.create({ ...base(), createdById: userId });
    if ("error" in result) throw new Error(result.error);

    expect(result.data.createdBy?.id).toBe(userId);
    expect(result.data.createdByEmployee).toBeNull();
  });

  describe("changing a comment", () => {
    const here = { kind: "display", stationId: null as string | null, workcenterId: null as string | null } as const;
    const terminal = async () => {
      const result = await comments.create({ ...base(), createdById: null, createdByEmployeeId: employeeId });
      if ("error" in result) throw new Error(result.error);
      return result.data.id;
    };

    test("the terminal at its station edits and deletes the terminal's comment", async () => {
      const id = await terminal();
      const actor = { ...here, stationId };

      const edited = await comments.update(id, { text: "Hopper ran low at 10:15", actor });
      if (edited.error !== undefined) throw new Error(edited.error);
      expect(edited.data.text).toBe("Hopper ran low at 10:15");

      expect(await comments.remove(id, { actor })).toEqual({ success: true });
      const row = await prisma.shiftComment.findUniqueOrThrow({ where: { id } });
      expect(row.deletedAt).not.toBeNull();
    });

    test("a display with no station changes terminal comments on its workcenter", async () => {
      const id = await terminal();
      const result = await comments.update(id, { text: "Fixed", actor: { ...here, workcenterId } });
      expect(result.error).toBeUndefined();
    });

    test("a terminal at another station cannot", async () => {
      const id = await terminal();
      const actor = { ...here, stationId: randomUUID() };
      expect((await comments.update(id, { text: "No", actor })).code).toBe("FORBIDDEN");
      expect((await comments.remove(id, { actor })).code).toBe("FORBIDDEN");
    });

    test("a terminal cannot change a signed-in user's comment, nor a user a terminal's", async () => {
      const mine = await comments.create({ ...base(), createdById: userId });
      if ("error" in mine) throw new Error(mine.error);
      const atStation = { ...here, stationId };
      expect((await comments.update(mine.data.id, { text: "No", actor: atStation })).code).toBe("FORBIDDEN");

      const theirs = await terminal();
      const asUser = { kind: "user", id: userId } as const;
      expect((await comments.update(theirs, { text: "No", actor: asUser })).code).toBe("FORBIDDEN");
      // The user still changes their own.
      expect((await comments.update(mine.data.id, { text: "Yes", actor: asUser })).error).toBeUndefined();
    });

    test("a terminal cannot change a note once its shift has ended; a user still can their own", async () => {
      const ended = { ...base(), shiftInstanceId: endedShiftInstanceId };
      const fromTerminal = await comments.create({ ...ended, createdById: null, createdByEmployeeId: employeeId });
      if ("error" in fromTerminal) throw new Error(fromTerminal.error);
      const actor = { ...here, stationId };
      expect((await comments.update(fromTerminal.data.id, { text: "Late", actor })).code).toBe("SHIFT_ENDED");
      expect((await comments.remove(fromTerminal.data.id, { actor })).code).toBe("SHIFT_ENDED");

      const fromUser = await comments.create({ ...ended, createdById: userId });
      if ("error" in fromUser) throw new Error(fromUser.error);
      const asUser = { kind: "user", id: userId } as const;
      expect((await comments.update(fromUser.data.id, { text: "Tidied", actor: asUser })).error).toBeUndefined();
    });
  });

  test("list returns both kinds of author", async () => {
    const result = await comments.list({ shiftInstanceId, workcenterId });
    const authors = result.data.map((comment) => comment.createdBy?.id ?? comment.createdByEmployee?.id);
    expect(authors).toContain(userId);
    expect(authors).toContain(employeeId);
  });
});
