import { describe, expect, it } from "vitest";
import { buildServer } from "./helpers/build-server.js";

describe("swagger gating", () => {
  it("serves /docs when swagger is enabled", async () => {
    const server = buildServer({ swagger: true });
    await server.ready();
    try {
      const res = await server.inject({ method: "GET", url: "/docs" });
      expect([200, 302]).toContain(res.statusCode);
    } finally {
      await server.close();
    }
  });

  it("404s /docs when swagger is disabled (production default)", async () => {
    const server = buildServer({ swagger: false });
    await server.ready();
    try {
      const res = await server.inject({ method: "GET", url: "/docs" });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
