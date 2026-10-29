import { beforeEach, describe, expect, test, vi } from "vitest";

const db = vi.hoisted(() => ({
  tool: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock("@rw/db", async (importOriginal) => ({ ...(await importOriginal<object>()), default: db }));
vi.mock("../entity/events.js", () => ({ publishEntityEvent: vi.fn() }));

const { remove } = await import("./tool.js");

const TOOL = "06320d59-b2e4-4b72-987c-65eac20d803b";

// What findUnique returns once the counts are filtered to live links.
const tool = (counts: { jobs: number; jobProducts: number }) => ({
  id: TOOL,
  siteId: "site",
  deletedAt: null,
  site: { workspaceId: "workspace" },
  _count: counts,
});

beforeEach(() => {
  db.tool.findUnique.mockReset();
  db.tool.update.mockReset().mockResolvedValue({});
});

describe("remove", () => {
  test("counts only live links: not ones taken off a job, nor a deleted job's", async () => {
    db.tool.findUnique.mockResolvedValue(tool({ jobs: 0, jobProducts: 0 }));
    await remove(TOOL);
    const live = { where: { deletedAt: null, job: { deletedAt: null } } };
    expect(db.tool.findUnique.mock.calls[0]![0].include._count).toEqual({
      select: { jobs: live, jobProducts: live },
    });
  });

  test("deletes a tool whose only links were to a deleted job", async () => {
    db.tool.findUnique.mockResolvedValue(tool({ jobs: 0, jobProducts: 0 }));
    expect(await remove(TOOL)).toEqual({ success: true });
    expect(db.tool.update).toHaveBeenCalledWith({
      where: { id: TOOL },
      data: { deletedAt: expect.any(Date) },
    });
  });

  test("still refuses a tool a live job uses", async () => {
    db.tool.findUnique.mockResolvedValue(tool({ jobs: 1, jobProducts: 0 }));
    expect(await remove(TOOL)).toMatchObject({ code: "HAS_JOBS" });
    db.tool.findUnique.mockResolvedValue(tool({ jobs: 0, jobProducts: 1 }));
    expect(await remove(TOOL)).toMatchObject({ code: "HAS_JOB_PRODUCTS" });
    expect(db.tool.update).not.toHaveBeenCalled();
  });
});
