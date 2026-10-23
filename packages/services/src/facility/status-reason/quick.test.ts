import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import * as statusReason from "./crud.js";

// Integration tests (shift-signoff.test.ts conventions): require DATABASE_URL.
// Covers a reason's quick flag: off unless asked for, and kept through other edits.

describe.skipIf(!process.env.DATABASE_URL)("status reason quick", () => {
  let siteId: string;

  beforeAll(async () => {
    // One workspace per deployment: use it.
    const workspace = await prisma.workspace.findFirstOrThrow();
    siteId = (await prisma.site.create({ data: { name: `Quick Site ${randomUUID()}`, workspaceId: workspace.id } })).id;
  });

  afterAll(async () => {
    await prisma.site.delete({ where: { id: siteId } });
  });

  // The service returns { data } or { error, code }; a test wants the row.
  const row = <T>(result: { data?: T; error?: string }): T => {
    if (result.data === undefined) throw new Error(result.error ?? "no data");
    return result.data;
  };

  test("a new reason is not quick unless asked", async () => {
    expect(row(await statusReason.create({ siteId, name: "Material" })).quick).toBe(false);
    expect(row(await statusReason.create({ siteId, name: "Mold change", quick: true })).quick).toBe(true);
  });

  test("quick turns on and off, and other edits leave it alone", async () => {
    const { id } = row(await statusReason.create({ siteId, name: "Waiting" }));
    expect(row(await statusReason.update(id, { quick: true })).quick).toBe(true);
    expect(row(await statusReason.update(id, { name: "Waiting on QC" })).quick).toBe(true);
    expect(row(await statusReason.update(id, { quick: false })).quick).toBe(false);
  });
});
