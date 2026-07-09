import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "..");
const repoRoot = resolve(apiRoot, "../..");

export const TEST_ADMIN_EMAIL = "admin@test.local";
export const TEST_ADMIN_PASSWORD = "test-password-123";

// When TEST_DATABASE_URL is set, prepare it for Tier 2: migrate to head and
// seed the default workspace/roles/admin. The seed no-ops once bootstrapped,
// so a reused test DB is fine.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.log("[test] TEST_DATABASE_URL not set — running Tier 1 (no-infra) tests only");
    return;
  }

  execSync("pnpm --filter @rw/db prisma:migrate", {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_MIGRATION: url },
  });

  execSync("pnpm exec tsx src/seed.ts", {
    cwd: apiRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: url,
      ADMIN_EMAIL: TEST_ADMIN_EMAIL,
      ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    },
  });
}
