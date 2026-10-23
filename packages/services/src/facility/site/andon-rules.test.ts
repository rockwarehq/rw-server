import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import prisma from "@rw/db";
import * as andonRules from "./andon-rules.js";

// Integration tests (shift-signoff.test.ts conventions): require DATABASE_URL.
// Covers a rule's pulse: off unless asked for, and kept through other edits.

describe.skipIf(!process.env.DATABASE_URL)("andon rule pulse", () => {
  let siteId: string;

  beforeAll(async () => {
    // One workspace per deployment: use it.
    const workspace = await prisma.workspace.findFirstOrThrow();
    siteId = (await prisma.site.create({ data: { name: `Andon Site ${randomUUID()}`, workspaceId: workspace.id } })).id;
  });

  afterAll(async () => {
    await prisma.site.delete({ where: { id: siteId } });
  });

  // The service returns { data } or { error, code }; a test wants the row.
  const row = <T>(result: { data?: T; error?: string }): T => {
    if (result.data === undefined) throw new Error(result.error ?? "no data");
    return result.data;
  };

  const rule = { expression: 'status == "DOWN"', referencedVariables: ["status"], colorHex: "#b60205" };

  test("a new rule is steady unless it asks to pulse", async () => {
    const steady = await andonRules.create({ siteId, ...rule });
    const pulsing = await andonRules.create({ siteId, ...rule, pulse: true });
    expect(row(steady).pulse).toBe(false);
    expect(row(pulsing).pulse).toBe(true);
  });

  test("pulse turns on and off, and other edits leave it alone", async () => {
    const { id } = row(await andonRules.create({ siteId, ...rule }));

    const on = await andonRules.update({ id, pulse: true });
    expect(row(on).pulse).toBe(true);
    const renamed = await andonRules.update({ id, name: "Down" });
    expect(row(renamed).pulse).toBe(true);
    const off = await andonRules.update({ id, pulse: false });
    expect(row(off).pulse).toBe(false);

    const listed = await andonRules.list({ siteId });
    expect(row(listed).find((saved) => saved.id === id)?.pulse).toBe(false);
  });
});
