// Boots the Fastify server far enough to register all routes + the swagger
// plugin, then serializes the OpenAPI spec to <repo-root>/openapi.json. This
// is the input consumed by @rockwarehq/api-client's openapi-ts generation.
//
// createServer() only registers plugins/routes; queue/Redis/DB initialization
// happens separately in main(), so this does not require live infra.

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { serverConfig } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const outPath = resolve(repoRoot, "openapi.json");

async function generateOpenAPI() {
  const { server } = createServer(serverConfig);
  await server.ready();

  const spec = (server as unknown as { swagger: () => object }).swagger();
  writeFileSync(outPath, JSON.stringify(spec, null, 2));

  console.log(`OpenAPI spec written to ${outPath}`);
  await server.close();
  process.exit(0);
}

generateOpenAPI().catch((err) => {
  console.error("Failed to generate OpenAPI spec:", err);
  process.exit(1);
});
