import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@rw/db": fromRoot("../db/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    // tsc -b emits compiled copies of the tests into dist/; only run the sources.
    include: ["src/**/*.test.ts"],
  },
});
