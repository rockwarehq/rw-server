import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Two-tier suite:
//   Tier 1 (always): HTTP-surface smoke tests — no DB/Redis/NATS needed
//     (createServer never dials infra; prisma is a lazy proxy).
//   Tier 2 (describe.skipIf(!TEST_DATABASE_URL)): auth flows against a real
//     Postgres. global-setup migrates + seeds it.
export default defineConfig({
  resolve: {
    alias: {
      "@rw/db": fromRoot("../../packages/db/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: "./test/global-setup.ts",
    // Shared DB + per-instance in-memory rate-limit stores: keep files serial.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
    },
  },
});
