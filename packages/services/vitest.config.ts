import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@rw/db": fromRoot("../db/src/index.ts"),
      "@rw/runtime/storage": fromRoot("../runtime/src/storage.ts"),
    },
  },
  test: {
    environment: "node",
    // Only run from src — never the tsc-compiled copies under dist.
    include: ["src/**/*.test.ts"],
  },
});
