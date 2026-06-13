import "dotenv/config";
import bcrypt from "bcrypt";
import prisma from "@rw/db";
import { findSystemRole } from "@rw/services/iam/roles";
import { seedSystemObjectSchemas } from "@rw/services/entity/system-catalog";
import { seedSystemRoles } from "./seed-system-roles.js";

const SALT_ROUNDS = 10;

// Bootstrap a tenant database with the default workspace, RBAC system roles,
// a Company Administrator user, and the default site + employee roles.
//
// Idempotent (all upserts), so it is safe to re-run. Reads ADMIN_EMAIL /
// ADMIN_PASSWORD from the environment (Fly secrets in production); falls back
// to insecure defaults for local use only.
//
// Run locally:   pnpm --filter @rw/api db:seed        (tsx src/seed.ts)
// Run compiled:  node dist/seed.js                    (used by fly release_command)
async function seed() {
  console.log("Starting database seed...");

  await seedSystemObjectSchemas();
  console.log("Seeded system object schemas");

  // Skip if already bootstrapped. Lets the seed run unconditionally on every
  // deploy (no SEED_ON_RELEASE flag needed) while staying a fast no-op once a
  // tenant DB has been seeded — only an empty DB gets bootstrapped.
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    console.log(`Seed: ${existingUsers} user(s) already exist — already bootstrapped, skipping.`);
    return;
  }

  // Create default workspace
  const workspace = await prisma.workspace.upsert({
    where: { slug: "default" },
    update: {},
    create: {
      name: "Default",
      slug: "default",
      description: "Default workspace",
      isDefault: true,
    },
  });

  console.log(`Created workspace: ${workspace.name} (${workspace.id})`);

  // Seed RBAC system roles for the workspace.
  await seedSystemRoles(workspace.id);
  console.log(`Seeded RBAC system roles for ${workspace.name}`);

  // Create admin user
  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "changeme123";

  const passwordHash = await bcrypt.hash(adminPassword, SALT_ROUNDS);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash,
      firstName: "Admin",
      status: "ACTIVE",
    },
  });

  console.log(`Created admin user: ${admin.email} (${admin.id})`);

  // Add admin as a workspace member + grant the Company Administrator RoleAssignment.
  // Upserts so seed can re-run safely.
  const membership = await prisma.workspaceMembership.upsert({
    where: { userId_workspaceId: { userId: admin.id, workspaceId: workspace.id } },
    update: {},
    create: { userId: admin.id, workspaceId: workspace.id },
  });

  console.log(`Added ${admin.email} as Company Administrator of ${workspace.name}`);

  const companyAdministratorRole = await findSystemRole(workspace.id, "Company Administrator", "WORKSPACE");
  if (!companyAdministratorRole) {
    throw new Error(`Company Administrator system role missing for workspace ${workspace.id}`);
  }
  const existingAssignment = await prisma.roleAssignment.findFirst({
    where: { membershipId: membership.id, siteId: null },
  });
  if (existingAssignment && existingAssignment.roleId !== companyAdministratorRole.id) {
    await prisma.roleAssignment.delete({ where: { id: existingAssignment.id } });
  }
  if (!existingAssignment || existingAssignment.roleId !== companyAdministratorRole.id) {
    await prisma.roleAssignment.create({
      data: { membershipId: membership.id, roleId: companyAdministratorRole.id, siteId: null },
    });
  }

  // Create default site
  const rockwareSite = await prisma.site.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "Rockware" } },
    update: {},
    create: {
      name: "Rockware",
      workspaceId: workspace.id,
      timezone: "America/New_York",
    },
  });
  console.log(`Created site: ${rockwareSite.name} (${rockwareSite.id})`);

  // Seed default employee roles for each site
  const sites = await prisma.site.findMany({ select: { id: true, name: true } });
  const defaultRoles = [
    "Operator",
    "Supervisor",
    "Lead",
    "Quality",
    "Maintenance",
    "Contractor",
    "Engineer",
    "Manager",
  ];

  for (const site of sites) {
    for (const roleName of defaultRoles) {
      await prisma.employeeRole.upsert({
        where: { siteId_name: { siteId: site.id, name: roleName } },
        update: {},
        create: { siteId: site.id, name: roleName },
      });
    }
    console.log(`Seeded ${defaultRoles.length} employee roles for site: ${site.name}`);
  }

  // NOTE: never log adminPassword — in production this output goes to fly
  // deploy logs. The operator already knows the password they set.
  console.log("\nSeed completed successfully!");
  console.log(`Admin user: ${adminEmail}`);
}

seed()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
