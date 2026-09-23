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
  let userId: string;
  let employeeId: string;
  let employeeVersionId: string;
  let foreignEmployeeId: string;

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
    const workspace = await prisma.workspace.create({
      data: { name: `Comments ${suffix}`, slug: `comments-${suffix}` },
    });
    const otherWorkspace = await prisma.workspace.create({
      data: { name: `Comments other ${suffix}`, slug: `comments-other-${suffix}` },
    });
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

    userId = (await prisma.user.create({ data: { email: `commenter-${suffix}@test.local`, passwordHash: "x" } })).id;
    await prisma.workspaceMembership.create({ data: { userId, workspaceId: workspace.id } });

    ({ employeeId, versionId: employeeVersionId } = await createEmployee(workspace.id, "Floor"));
    ({ employeeId: foreignEmployeeId } = await createEmployee(otherWorkspace.id, "Elsewhere"));
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

  test("an employee from another workspace is refused", async () => {
    const result = await comments.create({ ...base(), createdById: null, createdByEmployeeId: foreignEmployeeId });
    expect("error" in result && result.code).toBe("EMPLOYEE_NOT_FOUND");
  });

  test("a signed-in user's comment keeps the user, with no employee when none is linked", async () => {
    const result = await comments.create({ ...base(), createdById: userId });
    if ("error" in result) throw new Error(result.error);

    expect(result.data.createdBy?.id).toBe(userId);
    expect(result.data.createdByEmployee).toBeNull();
  });

  test("list returns both kinds of author", async () => {
    const result = await comments.list({ shiftInstanceId, workcenterId });
    const authors = result.data.map((comment) => comment.createdBy?.id ?? comment.createdByEmployee?.id);
    expect(authors).toContain(userId);
    expect(authors).toContain(employeeId);
  });
});
