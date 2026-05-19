import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Handle both dev (src/plugins/) and prod (dist/src/plugins/) paths
const pkgPath = existsSync(join(__dirname, "../../package.json"))
  ? join(__dirname, "../../package.json")
  : join(__dirname, "../../../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

export default fp(async (fastify) => {
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "Rockware API",
        description: "Rockware API Server",
        version: pkg.version,
      },
      servers: [{ url: "/" }],
      tags: [
        { name: "auth", description: "Authentication endpoints" },
        { name: "users", description: "User management" },
        { name: "workspaces", description: "Workspace operations" },
        { name: "locations", description: "Location management" },
        { name: "gateways", description: "Gateway operations" },
        { name: "datasources", description: "Data source configuration" },
        { name: "points", description: "Point management" },
        { name: "groups", description: "Group operations" },
        { name: "drivers", description: "Driver registry" },
        { name: "edge", description: "Gateway-to-server protocol" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
  });
});
