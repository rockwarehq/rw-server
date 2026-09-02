import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // tsc -b emits compiled copies of the tests into dist/; only run the sources.
    include: ["src/**/*.test.ts"],
  },
});
