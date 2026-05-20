import "dotenv/config";
import { defineConfig } from "prisma/config";

// Migrations MUST run against a direct (non-pooled) connection — pgbouncer
// transaction mode breaks Prisma's migration engine (advisory locks, session
// state, DDL). Prefer DATABASE_URL_MIGRATION if set, otherwise fall back to
// DATABASE_URL (still works when the whole app uses direct connections).
//
// `prisma generate` runs in CI/build without DB env; the placeholder keeps
// codegen from failing.
const databaseUrl =
  process.env.DATABASE_URL_MIGRATION ??
  process.env.DATABASE_URL ??
  "postgresql://placeholder:placeholder@localhost:5432/placeholder";

export default defineConfig({
  schema: "schema",
  migrations: {
    path: "migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
