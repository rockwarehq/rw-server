import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import * as signoffs from "./shift-signoff.js";

// Integration tests (document.test.ts conventions): require DATABASE_URL and
// exercise the post/reopen/re-post lifecycle against an isolated fixture
// graph: one site with two workcenters, a workcenter-scoped shift instance
// and a site-level (shared) one.

describe.skipIf(!process.env.DATABASE_URL)("shiftSignoff service", () => {
  let siteId: string;
  let otherSiteId: string;
  let workcenterId: string;
  let otherWorkcenterId: string;
  let scopedInstanceId: string;
  let siteLevelInstanceId: string;
  let posterId: string;
  let reopenerId: string;

  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  beforeAll(async () => {
    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({
      data: { name: `Signoff ${suffix}`, slug: `signoff-${suffix}` },
    });
    siteId = (await prisma.site.create({ data: { name: `Signoff Site ${suffix}`, workspaceId: workspace.id } })).id;
    otherSiteId = (await prisma.site.create({ data: { name: `Signoff Other ${suffix}`, workspaceId: workspace.id } }))
      .id;
    workcenterId = (await prisma.workcenter.create({ data: { name: `WC ${suffix}`, siteId } })).id;
    otherWorkcenterId = (await prisma.workcenter.create({ data: { name: `WC2 ${suffix}`, siteId } })).id;

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
    const instance = (workCenterId: string | null, start: Date, end: Date) =>
      prisma.shiftInstance.create({
        data: {
          assignmentId: assignment.id,
          definitionId: definition.id,
          siteId,
          workCenterId,
          shiftName: "S",
          businessDate: start,
          startTime: start,
          endTime: end,
        },
      });
    scopedInstanceId = (await instance(workcenterId, at(-8), at(0))).id;
    siteLevelInstanceId = (await instance(null, at(-16), at(-8))).id;

    posterId = (await prisma.user.create({ data: { email: `poster-${suffix}@test.local`, passwordHash: "x" } })).id;
    reopenerId = (await prisma.user.create({ data: { email: `reopener-${suffix}@test.local`, passwordHash: "x" } })).id;
  });

  test("create posts a sign-off with the poster subselect", async () => {
    const result = await signoffs.create({
      siteId,
      shiftInstanceId: scopedInstanceId,
      workcenterId,
      postedById: posterId,
    });
    if (result.error !== undefined) throw new Error(result.error);
    expect(result.data.shiftInstanceId).toBe(scopedInstanceId);
    expect(result.data.workcenterId).toBe(workcenterId);
    expect(result.data.postedBy?.id).toBe(posterId);
    expect(result.data.postedAt).toBeInstanceOf(Date);

    const read = await signoffs.get({ shiftInstanceId: scopedInstanceId, workcenterId });
    expect(read.data?.id).toBe(result.data.id);
  });

  test("double create on the same pair is ALREADY_SIGNED_OFF", async () => {
    const again = await signoffs.create({
      siteId,
      shiftInstanceId: scopedInstanceId,
      workcenterId,
      postedById: posterId,
    });
    expect(again.code).toBe("ALREADY_SIGNED_OFF");
  });

  test("validation: unknown instance, wrong site, wrong workcenter", async () => {
    const missing = await signoffs.create({
      siteId,
      shiftInstanceId: randomUUID(),
      workcenterId,
      postedById: posterId,
    });
    expect(missing.code).toBe("SHIFT_INSTANCE_NOT_FOUND");

    const wrongSite = await signoffs.create({
      siteId: otherSiteId,
      shiftInstanceId: scopedInstanceId,
      workcenterId,
      postedById: posterId,
    });
    expect(wrongSite.code).toBe("SITE_MISMATCH");

    const wrongWorkcenter = await signoffs.create({
      siteId,
      shiftInstanceId: scopedInstanceId,
      workcenterId: otherWorkcenterId,
      postedById: posterId,
    });
    expect(wrongWorkcenter.code).toBe("WORKCENTER_MISMATCH");
  });

  test("a site-level instance accepts sign-offs from any workcenter, independently", async () => {
    const first = await signoffs.create({
      siteId,
      shiftInstanceId: siteLevelInstanceId,
      workcenterId,
      postedById: posterId,
    });
    expect(first.error).toBeUndefined();

    const second = await signoffs.create({
      siteId,
      shiftInstanceId: siteLevelInstanceId,
      workcenterId: otherWorkcenterId,
      postedById: posterId,
    });
    expect(second.error).toBeUndefined();

    const readOther = await signoffs.get({ shiftInstanceId: siteLevelInstanceId, workcenterId: otherWorkcenterId });
    expect(readOther.data?.workcenterId).toBe(otherWorkcenterId);
  });

  test("reopen soft-deletes, get returns null, second reopen is SIGNOFF_NOT_FOUND", async () => {
    const removed = await signoffs.remove({
      siteId,
      shiftInstanceId: scopedInstanceId,
      workcenterId,
      actorId: reopenerId,
    });
    expect(removed.error).toBeUndefined();

    const read = await signoffs.get({ shiftInstanceId: scopedInstanceId, workcenterId });
    expect(read.data).toBeNull();

    const again = await signoffs.remove({
      siteId,
      shiftInstanceId: scopedInstanceId,
      workcenterId,
      actorId: reopenerId,
    });
    expect(again.code).toBe("SIGNOFF_NOT_FOUND");

    const row = await prisma.shiftSignoff.findFirst({
      where: { shiftInstanceId: scopedInstanceId, workcenterId },
    });
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.reopenedById).toBe(reopenerId);
  });

  test("re-post after reopen revives the same pair with the new poster", async () => {
    const revived = await signoffs.create({
      siteId,
      shiftInstanceId: scopedInstanceId,
      workcenterId,
      postedById: reopenerId,
    });
    if (revived.error !== undefined) throw new Error(revived.error);
    expect(revived.data.postedBy?.id).toBe(reopenerId);

    const read = await signoffs.get({ shiftInstanceId: scopedInstanceId, workcenterId });
    expect(read.data?.id).toBe(revived.data.id);
  });

  test("remove with the wrong site is SIGNOFF_NOT_FOUND", async () => {
    const wrongSite = await signoffs.remove({
      siteId: otherSiteId,
      shiftInstanceId: scopedInstanceId,
      workcenterId,
      actorId: reopenerId,
    });
    expect(wrongSite.code).toBe("SIGNOFF_NOT_FOUND");
  });
});
