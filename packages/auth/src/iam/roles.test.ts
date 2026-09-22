import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ role: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() } }));
vi.mock("@rw/db", () => ({ default: db }));
import { create, update } from "./roles.js";

beforeEach(() => vi.resetAllMocks());

describe("custom role mutation", () => {
  it("stores a WC custom role without broadening its permissions", async () => {
    await create({
      workspaceId: "workspace",
      name: "Line editor",
      scope: "WORKCENTER",
      permissions: ["production:write"],
    });
    expect(db.role.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace",
        name: "Line editor",
        description: undefined,
        scope: "WORKCENTER",
        permissions: ["production:write"],
        isSystem: false,
      },
    });
  });

  it("enforces the existing scope during an update, not merely during creation", async () => {
    db.role.findUnique.mockResolvedValue({ isSystem: false, scope: "WORKCENTER" });
    await expect(update("role", { permissions: ["configuration:write"] })).rejects.toThrow(/only contain production/);
    expect(db.role.update).not.toHaveBeenCalled();
  });

  it("cannot create ownership or modify built-ins", async () => {
    await expect(
      create({ workspaceId: "workspace", name: "Owner", scope: "WORKSPACE", permissions: ["owner:all"] }),
    ).rejects.toThrow(/reserved/);
    db.role.findUnique.mockResolvedValue({ isSystem: true, scope: "SITE" });
    await expect(update("role", { permissions: [] })).rejects.toThrow(/System roles/);
    expect(db.role.create).not.toHaveBeenCalled();
    expect(db.role.update).not.toHaveBeenCalled();
  });
});
