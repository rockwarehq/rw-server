import "dotenv/config";
import prisma from "@rw/db";

// Dev/test only: fold every workspace into one, so the database fits the
// one-account-per-deployment rule (migration 20260928100000_account_admin_flag
// refuses to run while more than one exists). Tests used to create their
// own workspaces, so local databases collect dozens.
//
// Nothing is deleted except the emptied workspace rows. The workspace with
// the most members is kept (then the most sites, then the oldest), or the
// one named on the command line; every row of the others moves into it. Names that
// would clash (sites, roles, object schemas) get the old workspace's short
// id appended. Duplicate SMS consents for the same phone keep the kept
// workspace's row.
//
// Usage (before migrating):
//   DATABASE_URL=… pnpm exec tsx apps/api/scripts/collapse-workspaces.ts [workspaceIdToKeep]

const TABLES_WITH_WORKSPACE = [
  "ApiToken",
  "AuditLog",
  "Bucket",
  "Employee",
  "Location",
  "ObjectSchema",
  "Role",
  "Site",
  "SmsConsent",
  "WorkspaceMember",
];

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to run with NODE_ENV=production");

  const [keepId] = process.argv.slice(2);
  const workspaces = await prisma.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT w."id", w."name"
    FROM "Workspace" w
    ORDER BY (SELECT count(*) FROM "WorkspaceMember" m WHERE m."workspaceId" = w."id") DESC,
             (SELECT count(*) FROM "Site" s WHERE s."workspaceId" = w."id") DESC,
             w."createdAt" ASC`;
  if (workspaces.length <= 1) {
    console.log(`Nothing to do: ${workspaces.length} workspace(s).`);
    return;
  }
  const keep = keepId ? workspaces.find((w) => w.id === keepId) : workspaces[0];
  if (!keep) throw new Error(`No workspace ${keepId}`);

  // A user in two workspaces would need a merge decision; say so instead.
  const doubled = await prisma.$queryRaw<Array<{ userId: string }>>`
    SELECT "userId" FROM "WorkspaceMember" GROUP BY "userId" HAVING count(*) > 1`;
  if (doubled.length > 0) {
    throw new Error(`${doubled.length} user(s) belong to more than one workspace; merge them by hand first.`);
  }

  // Older databases may predate some tables (Bucket, …); skip those.
  const present = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()`;
  const has = new Set(present.map((t) => t.name));

  await prisma.$transaction(async (tx) => {
    const suffix = `' (' || left(t."workspaceId"::text, 8) || ')'`;
    // Rename rows whose name is already used in the kept workspace.
    for (const [table, extra] of [
      ["Site", ""],
      ["ObjectSchema", ""],
      ["Role", ` AND k."scope" = t."scope"`],
    ] as const) {
      await tx.$executeRawUnsafe(
        `UPDATE "${table}" t SET "name" = t."name" || ${suffix}
         WHERE t."workspaceId" <> $1::uuid
           AND EXISTS (SELECT 1 FROM "${table}" k WHERE k."workspaceId" = $1::uuid AND k."name" = t."name"${extra})`,
        keep.id,
      );
    }
    // Same name in two moved workspaces: make the moved names unique too.
    for (const [table, key, rowKey] of [
      ["Site", `"name"`, `t."name"`],
      ["ObjectSchema", `"name"`, `t."name"`],
      ["Role", `"name", "scope"`, `t."name", t."scope"`],
    ] as const) {
      await tx.$executeRawUnsafe(
        `UPDATE "${table}" t SET "name" = t."name" || ${suffix}
         WHERE t."workspaceId" <> $1::uuid
           AND (${rowKey}) IN (
             SELECT ${key} FROM "${table}" WHERE "workspaceId" <> $1::uuid GROUP BY ${key} HAVING count(*) > 1)`,
        keep.id,
      );
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM "SmsConsent" t WHERE t."workspaceId" <> $1::uuid
         AND EXISTS (SELECT 1 FROM "SmsConsent" k WHERE k."workspaceId" = $1::uuid AND k."phone" = t."phone")`,
      keep.id,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "SmsConsent" t WHERE t."workspaceId" <> $1::uuid
         AND t."id" <> (SELECT min(k."id"::text)::uuid FROM "SmsConsent" k WHERE k."workspaceId" <> $1::uuid AND k."phone" = t."phone")`,
      keep.id,
    );

    for (const table of TABLES_WITH_WORKSPACE.filter((t) => has.has(t))) {
      await tx.$executeRawUnsafe(
        `UPDATE "${table}" SET "workspaceId" = $1::uuid WHERE "workspaceId" IS NOT NULL AND "workspaceId" <> $1::uuid`,
        keep.id,
      );
    }
    await tx.$executeRawUnsafe(`DELETE FROM "Workspace" WHERE "id" <> $1::uuid`, keep.id);
  });

  console.log(`Kept "${keep.name}" (${keep.id}); folded in ${workspaces.length - 1} other workspace(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
