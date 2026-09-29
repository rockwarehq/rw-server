import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import prisma, { ensureAccountWorkspace } from "@rw/db";
import { create, update } from "./pattern.js";

// Integration tests for a weekly schedule's week start. Require DATABASE_URL.

describe.skipIf(!process.env.DATABASE_URL)("schedule week start follows the site", () => {
  let siteId: string;

  beforeAll(async () => {
    const workspace = await ensureAccountWorkspace({ name: "Test Account", slug: "test-account" });
    siteId = (
      await prisma.site.create({
        data: { name: `Week start ${randomUUID()}`, workspaceId: workspace.id, weekStart: "SUNDAY" },
      })
    ).id;
  });

  async function created(input: { totalDaysInRotation?: number; startOnDayOfWeek?: string }) {
    const result = await create({ name: "P", siteId, ...input });
    if (result.error !== undefined) throw new Error(result.error);
    return result.data;
  }

  test("a new weekly schedule starts on the site's week start", async () => {
    expect((await created({ totalDaysInRotation: 7 })).startOnDayOfWeek).toBe("SUNDAY");
    expect((await created({ totalDaysInRotation: 14 })).startOnDayOfWeek).toBe("SUNDAY");
  });

  test("a rotation that isn't whole weeks gets no weekday names", async () => {
    expect((await created({ totalDaysInRotation: 8 })).startOnDayOfWeek).toBeNull();
  });

  test("a starter's own layout is kept", async () => {
    expect((await created({ totalDaysInRotation: 7, startOnDayOfWeek: "MONDAY" })).startOnDayOfWeek).toBe("MONDAY");
  });

  test("becoming weekly takes the site's week start; an existing choice stays", async () => {
    const pattern = await created({ totalDaysInRotation: 8 });
    const weekly = await update(pattern.id, { totalDaysInRotation: 7 });
    expect(weekly.data?.startOnDayOfWeek).toBe("SUNDAY");

    const starter = await created({ totalDaysInRotation: 7, startOnDayOfWeek: "MONDAY" });
    const longer = await update(starter.id, { totalDaysInRotation: 14 });
    expect(longer.data?.startOnDayOfWeek).toBe("MONDAY");
  });
});
