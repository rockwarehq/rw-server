import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { createAccessToken } from "@rw/auth/verify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

// An operator terminal (a DISPLAY principal) posting a station comment. The
// display is no one, so the operator names themselves; editing and deleting
// stay with signed-in users, who own what they wrote.

type CommentJson = {
  id: string;
  createdBy: { id: string } | null;
  createdByEmployee: { id: string; version: { firstName: string } | null } | null;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("shift comments from a terminal", () => {
  let server: TestServer;
  let displayToken: string;
  let siteId: string;
  let workcenterId: string;
  let stationId: string;
  let shiftInstanceId: string;
  let employeeId: string;
  let otherSiteDisplayToken: string;

  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const suffix = randomUUID();
    // One workspace per deployment: use it.
    const workspace = await prisma.workspace.findFirstOrThrow();
    siteId = (await prisma.site.create({ data: { name: `Site ${suffix}`, workspaceId: workspace.id } })).id;
    const otherSiteId = (await prisma.site.create({ data: { name: `Other ${suffix}`, workspaceId: workspace.id } }))
      .id;
    workcenterId = (await prisma.workcenter.create({ data: { name: `WC ${suffix}`, siteId } })).id;
    stationId = (await prisma.station.create({ data: { name: `STN ${suffix}`, siteId, workcenterId } })).id;

    const pattern = await prisma.shiftPattern.create({ data: { siteId, name: "P" } });
    const definition = await prisma.shiftDefinition.create({
      data: { patternId: pattern.id, dayOfRotation: 1, sortOrder: 1, startTime: "06:00", durationHrs: 8, shiftName: "S" },
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

    employeeId = (await prisma.employee.create({ data: { workspaceId: workspace.id }, select: { id: true } })).id;
    const version = await prisma.employeeVersion.create({
      data: { employeeId, version: 1, firstName: "Floor", lastName: "Operator" },
      select: { id: true },
    });
    await prisma.employee.update({ where: { id: employeeId }, data: { versionId: version.id } });

    const claimedDisplay = async (displaySiteId: string) => {
      const display = await prisma.display.create({
        data: { status: "CLAIMED", siteId: displaySiteId, claimedAt: new Date() },
      });
      return createAccessToken({
        principal: "DISPLAY",
        displayId: display.id,
        siteId: displaySiteId,
        workspaceId: workspace.id,
      });
    };
    displayToken = await claimedDisplay(siteId);
    otherSiteDisplayToken = await claimedDisplay(otherSiteId);
  });

  afterAll(async () => {
    await server?.close();
  });

  const input = (extra: Record<string, unknown> = {}) => ({
    siteId,
    shiftInstanceId,
    workCenterId: workcenterId,
    stationId,
    text: "Material hopper ran low",
    ...extra,
  });

  it("posts, attributed to the operator it names", async () => {
    const res = await rpcCall(server, "shiftRecap/commentCreate", input({ employeeId }), displayToken);

    expect(res.statusCode).toBe(200);
    const comment = res.json as CommentJson;
    expect(comment.createdBy).toBeNull();
    expect(comment.createdByEmployee?.id).toBe(employeeId);
    expect(comment.createdByEmployee?.version?.firstName).toBe("Floor");
  });

  it("refuses a comment that names no one", async () => {
    const res = await rpcCall(server, "shiftRecap/commentCreate", input(), displayToken);

    expect(res.statusCode).toBe(400);
  });

  it("stays inside the display's own site", async () => {
    const res = await rpcCall(server, "shiftRecap/commentCreate", input({ employeeId }), otherSiteDisplayToken);

    expect(res.statusCode).toBe(403);
  });

  it("cannot edit or delete — those stay with signed-in users", async () => {
    const created = await rpcCall(server, "shiftRecap/commentCreate", input({ employeeId }), displayToken);
    const { id } = created.json as CommentJson;

    const update = await rpcCall(server, "shiftRecap/commentUpdate", { id, text: "changed" }, displayToken);
    const remove = await rpcCall(server, "shiftRecap/commentDelete", { id }, displayToken);

    expect(update.statusCode).toBeGreaterThanOrEqual(400);
    expect(remove.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("lists what it posted", async () => {
    const res = await rpcCall(
      server,
      "shiftRecap/commentList",
      { siteId, shiftInstanceId, workCenterId: workcenterId },
      displayToken,
    );

    expect(res.statusCode).toBe(200);
    const comments = res.json as CommentJson[];
    expect(comments.some((comment) => comment.createdByEmployee?.id === employeeId)).toBe(true);
  });
});
