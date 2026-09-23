import "dotenv/config";
import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";
import { ensureBuckets } from "./seed-buckets.js";

// Bootstrap a tenant database with the default workspace, an owner user,
// and the default site + employee roles. Access buckets are created with
// their sites/workcenters; there are no role bundles to seed.

// Every site gets exactly one system "Scrap" disposition: seeded, protected
// (no rename/removal — see inventory/disposition.ts), and resolved by the
// isSystem flag from scrap-all production modes. Imported sites adopt their
// existing spelling (e.g. legacy "SCRAP") by flagging it in place.
async function ensureScrapDisposition(siteId: string): Promise<void> {
  const system = await prisma.itemDisposition.findFirst({
    where: { siteId, isSystem: true, deletedAt: null },
    select: { id: true },
  });
  if (system) return;

  const existing = await prisma.itemDisposition.findFirst({
    where: { siteId, name: { equals: "scrap", mode: "insensitive" }, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    await prisma.itemDisposition.update({ where: { id: existing.id }, data: { isSystem: true } });
  } else {
    await prisma.itemDisposition.create({ data: { siteId, name: "Scrap", isSystem: true } });
  }
}
//
// Idempotent (all upserts), so it is safe to re-run. Reads ADMIN_EMAIL /
// ADMIN_PASSWORD from the environment (Fly secrets in production); falls back
// to insecure defaults for local use only.
//
// Run locally:   pnpm --filter @rw/api db:seed        (tsx src/seed.ts)
// Run compiled:  node dist/seed.js                    (used by fly release_command)
async function seed() {
  console.log("Starting database seed...");

  // Skip if already bootstrapped. Lets the seed run unconditionally on every
  // deploy (no SEED_ON_RELEASE flag needed) while staying a fast no-op once a
  // tenant DB has been seeded — only an empty DB gets bootstrapped.
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    // Buckets and the Scrap disposition are guaranteed on every deploy. The
    // rest of the bootstrap (owner user, site, employee roles) is skipped.
    await ensureBuckets();
    const allSites = await prisma.site.findMany({ select: { id: true } });
    for (const site of allSites) {
      await ensureScrapDisposition(site.id);
    }
    console.log(
      `Seed: ensured Scrap dispositions for ${allSites.length} site(s); ` +
        `${existingUsers} user(s) already exist — skipping bootstrap.`,
    );
    return;
  }

  // Production bootstrap guard — must sit AFTER the already-bootstrapped
  // early-return: the seed runs on every deploy (fly release_command), and
  // already-seeded tenants without ADMIN_* secrets must keep deploying.
  // A throw here aborts the release, which is the right outcome for a fresh
  // tenant missing its admin credentials.
  if (process.env.NODE_ENV === "production") {
    const missing = ["ADMIN_EMAIL", "ADMIN_PASSWORD"].filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Refusing to bootstrap a production tenant: set ${missing.join(", ")} via fly secrets`);
    }
    const adminPassword = process.env.ADMIN_PASSWORD as string;
    if (adminPassword === "changeme123" || adminPassword.length < 12) {
      throw new Error("ADMIN_PASSWORD must be >= 12 characters and not the dev default");
    }
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

  // Create admin user
  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "changeme123";

  const passwordHash = await hashPassword(adminPassword);

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

  // Add admin as the workspace OWNER (reserved ownership; bypasses
  // buckets). Upserts so seed can re-run safely.
  await prisma.workspaceMembership.upsert({
    where: { userId_workspaceId: { userId: admin.id, workspaceId: workspace.id } },
    update: { workspaceRole: "OWNER" },
    create: { userId: admin.id, workspaceId: workspace.id, workspaceRole: "OWNER" },
  });

  console.log(`Added ${admin.email} as owner of ${workspace.name}`);

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
    await ensureScrapDisposition(site.id);
    console.log(`Seeded ${defaultRoles.length} employee roles for site: ${site.name}`);
  }

  await ensureBuckets();

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
