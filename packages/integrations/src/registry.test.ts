import { describe, expect, it } from "vitest";
import { buildIntegrationCatalog } from "./catalog.js";
import { createDefaultIntegrationRegistry } from "./index.js";

const registry = createDefaultIntegrationRegistry();

describe("integration registry", () => {
  it("registers the built-in types", () => {
    expect(registry.types().sort()).toEqual(["rest", "sqlserver", "webhook"]);
  });

  it("rejects a duplicate registration", () => {
    const duplicate = createDefaultIntegrationRegistry();
    const sqlserver = duplicate.get("sqlserver");
    expect(sqlserver).toBeDefined();
    expect(() => duplicate.register(sqlserver as never)).toThrow(/already registered/);
  });

  it("applies config defaults", () => {
    const result = registry.validateSettings(
      "sqlserver",
      { host: "10.0.1.5", database: "MES", username: "rw_svc" },
      { password: "hunter2" },
    );

    expect(result).toMatchObject({ data: { config: { port: 1433, encrypt: true } } });
  });

  it("rejects a missing secret", () => {
    const result = registry.validateSettings("sqlserver", { host: "h", database: "d", username: "u" }, {});
    expect(result).toMatchObject({ code: "INTEGRATION_SECRET_INVALID" });
  });

  it("rejects a secret whose auth type disagrees with the config", () => {
    const result = registry.validateSettings(
      "rest",
      { baseUrl: "https://api.example.com", authType: "bearer" },
      { authType: "apiKey", apiKey: "abc" },
    );

    expect(result).toMatchObject({ code: "INTEGRATION_SETTINGS_INVALID" });
  });

  it("accepts a matching rest secret", () => {
    const result = registry.validateSettings(
      "rest",
      { baseUrl: "https://api.example.com", authType: "bearer" },
      { authType: "bearer", token: "abc" },
    );

    expect("data" in result).toBe(true);
  });

  it("validates action input against the latest version by default", () => {
    const result = registry.validateActionInput("sqlserver", "procedure.execute", undefined, {
      procedure: "dbo.RecordCycle",
      parameters: [{ name: "stationId", type: "string", value: "station-1" }],
    });

    expect(result).toMatchObject({ data: { timeoutMs: 30_000 } });
  });

  it("rejects a procedure name that is not a plain identifier", () => {
    const result = registry.validateActionInput("sqlserver", "procedure.execute", undefined, {
      procedure: "dbo.Record; DROP TABLE Cycles--",
    });

    expect(result).toMatchObject({ code: "ACTION_INPUT_INVALID" });
  });

  it("rejects an unknown action version", () => {
    const result = registry.validateActionInput("sqlserver", "procedure.execute", "9", {
      procedure: "dbo.RecordCycle",
    });

    expect(result).toMatchObject({ code: "UNKNOWN_ACTION_VERSION" });
  });

  it("reports an unknown type", () => {
    expect(registry.validateSettings("nope", {}, {})).toMatchObject({ code: "UNKNOWN_INTEGRATION_TYPE" });
  });
});

describe("integration catalog", () => {
  const catalog = buildIntegrationCatalog(registry);

  it("serializes every type for the console", () => {
    expect(catalog.map((entry) => entry.type).sort()).toEqual(["rest", "sqlserver", "webhook"]);
  });

  it("runs every built-in type in this process", () => {
    expect(catalog.every((entry) => entry.execution === "server")).toBe(true);
  });

  it("emits json schemas the console can render", () => {
    const sqlserver = catalog.find((entry) => entry.type === "sqlserver");
    expect(sqlserver?.configSchema).toMatchObject({ properties: { host: { type: "string" } } });
    expect(sqlserver?.secretSchema).toMatchObject({ properties: { password: { type: "string" } } });
    expect(sqlserver?.actions[0]?.versions["1"]?.inputSchema).toMatchObject({
      properties: { procedure: { type: "string" } },
    });
  });
});
