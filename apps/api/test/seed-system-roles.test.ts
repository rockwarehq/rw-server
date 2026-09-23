import prisma from "@rw/db";
import { CUSTOMER_PERMISSIONS } from "@rw/auth/iam/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ROLE_SPECS, seedSystemRoles } from "../src/seed-system-roles.js";

// Tier 2: seeding of the built-in role presets during the vocabulary
// transition — idempotent, dual-vocabulary bundles, and never adopting a
// customer's same-named role.
describe.skipIf(!process.env.TEST_DATABASE_URL)("seedSystemRoles (Tier 2)", () => {
  let workspaceId: string;

  beforeAll(async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Seed Test", slug: `seed-test-${Date.now()}` },
    });
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } });
  });

  it("seeds all five built-ins, except where a customer role owns the name", async () => {
    // A customer made their own "Planner" before the built-in existed.
    const customPlanner = await prisma.role.create({
      data: { workspaceId, name: "Planner", scope: "SITE", permissions: ["job:read"], isSystem: false },
    });

    await seedSystemRoles(workspaceId);

    // The customer's role is untouched — not promoted, not rewritten.
    const planner = await prisma.role.findMany({ where: { workspaceId, name: "Planner", scope: "SITE" } });
    expect(planner).toHaveLength(1);
    expect(planner[0].id).toBe(customPlanner.id);
    expect(planner[0].isSystem).toBe(false);
    expect(planner[0].permissions).toEqual(["job:read"]);

    // The other four built-ins exist as system roles.
    for (const spec of SYSTEM_ROLE_SPECS.filter((s) => s.name !== "Planner")) {
      const role = await prisma.role.findUnique({
        where: { workspaceId_name_scope: { workspaceId, name: spec.name, scope: spec.scope } },
      });
      expect(role?.isSystem, spec.name).toBe(true);
      expect([...(role?.permissions ?? [])].sort()).toEqual([...spec.permissions].sort());
    }
  });

  it("is idempotent: a second run changes nothing and duplicates nothing", async () => {
    await seedSystemRoles(workspaceId);
    const roles = await prisma.role.findMany({ where: { workspaceId } });
    // 4 system roles + the customer's Planner.
    expect(roles).toHaveLength(5);
  });

  it("transition bundles carry both vocabularies where the role predates the new keys", async () => {
    const member = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Plant Member", scope: "SITE" } },
    });
    expect(member.permissions).toContain("status:read"); // legacy half
    expect(member.permissions).toContain("planning:read"); // new half
    // Deliberately NOT production:read: member production visibility comes
    // from workcenter grants in the target model.
    expect(member.permissions).not.toContain("production:read");

    const admin = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Plant Admin", scope: "SITE" } },
    });
    for (const p of CUSTOMER_PERMISSIONS) expect(admin.permissions).toContain(p);
    expect(admin.permissions).not.toContain("owner:all");

    const engineer = await prisma.role.findUniqueOrThrow({
      where: { workspaceId_name_scope: { workspaceId, name: "Plant Engineer", scope: "SITE" } },
    });
    expect([...engineer.permissions].sort()).toEqual(["configuration:write", "planning:write", "production:admin"]);
  });
});
