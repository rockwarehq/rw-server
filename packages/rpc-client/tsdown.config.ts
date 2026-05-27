import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  clean: true,
  // Inline the AppRouter type graph (which reaches into the @rw/* workspace
  // packages) so the published .d.ts is self-contained for external consumers.
  dts: { resolve: [/^@rw\//] },
  format: ["esm"],
  outDir: "dist",
  unbundle: true,
});
