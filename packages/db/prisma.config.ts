import "dotenv/config";
import { defineConfig } from "prisma/config";

// DATABASE_URL is only required for `prisma migrate`/runtime; `prisma generate`
// runs in CI/build without it. Use the raw env var rather than env() so codegen
// doesn't fail when DATABASE_URL is absent.
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@localhost:5432/placeholder";

export default defineConfig({
  schema: "schema",
  migrations: {
    path: "migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
