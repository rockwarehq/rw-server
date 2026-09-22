import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Source-level, mocked-Prisma authorization tests. No DB setup, migration or package build.
export default defineConfig({
  resolve: { alias: [
    { find: /^@rw\/auth\/(.*)$/, replacement: root("../../../packages/auth/src/$1.ts") },
    { find: /^@rw\/services\/(.*)$/, replacement: root("../../../packages/services/src/$1.ts") },
    { find: "@rw/db", replacement: root("../../../packages/db/src/index.ts") },
  ] },
  test: {
    environment: "node",
    include: ["test/terminal-authorization.test.ts", "test/shift-recap-buckets.test.ts"],
    env: { NODE_ENV: "test" },
  },
});
