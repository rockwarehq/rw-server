import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateEncryptionKey, sealSecret } from "./crypto.js";
import { executeAction } from "./execute.js";
import { createDefaultIntegrationRegistry, createIntegrationRegistry } from "./index.js";

const KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";
const registry = createDefaultIntegrationRegistry();

describe("executeAction", () => {
  const originalKey = process.env[KEY_ENV];

  beforeEach(() => {
    process.env[KEY_ENV] = generateEncryptionKey();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = originalKey;
    vi.unstubAllGlobals();
  });

  it("refuses to run an action that declares edge execution", async () => {
    const edgeOnly = createIntegrationRegistry().register({
      type: "edge-only",
      displayName: "Edge Only",
      description: "Declares a contract with no in-process executor.",
      execution: "edge",
      configSchema: z.object({}),
      secretSchema: z.object({}),
      actions: [
        {
          key: "do",
          displayName: "Do",
          description: "",
          latest: "1",
          versions: { "1": { inputSchema: z.object({}) } },
        },
      ],
    });

    const result = await executeAction(
      edgeOnly,
      { id: "integration-1", type: "edge-only", name: "Edge", config: {}, secretCipher: null },
      "do",
      undefined,
      {},
    );

    expect(result).toMatchObject({ code: "EDGE_EXECUTION_REQUIRED" });
  });

  it("reports a secret sealed against a different integration id", async () => {
    const result = await executeAction(
      registry,
      {
        id: "integration-1",
        type: "webhook",
        name: "Ops",
        config: { url: "https://example.com/hook" },
        secretCipher: sealSecret({ signingSecret: "s3cret" }, "integration-2"),
      },
      "send",
      undefined,
      { payload: { ok: true } },
    );

    expect(result).toMatchObject({ code: "INTEGRATION_SECRET_UNREADABLE" });
  });

  it("runs an action and signs the payload", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeAction(
      registry,
      {
        id: "integration-1",
        type: "webhook",
        name: "Ops",
        config: { url: "https://example.com/hook" },
        secretCipher: sealSecret({ signingSecret: "s3cret" }, "integration-1"),
      },
      "send",
      undefined,
      { payload: { stationId: "station-1" } },
    );

    expect(result).toMatchObject({ data: { status: 204 } });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-rw-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(init.body).toBe(JSON.stringify({ stationId: "station-1" }));
  });

  it("keeps the baseUrl path prefix for leading-slash paths", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeAction(
      registry,
      {
        id: "integration-1",
        type: "rest",
        name: "Vendor",
        config: { baseUrl: "https://api.example.com/v2", authType: "none" },
        secretCipher: sealSecret({ authType: "none" }, "integration-1"),
      },
      "request",
      undefined,
      { path: "/orders", method: "GET" },
    );

    expect(result).toMatchObject({ data: { status: 200 } });
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.toString()).toBe("https://api.example.com/v2/orders");
  });

  it("surfaces a failing remote call as a result, not a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const result = await executeAction(
      registry,
      {
        id: "integration-1",
        type: "webhook",
        name: "Ops",
        config: { url: "https://example.com/hook" },
        secretCipher: null,
      },
      "send",
      undefined,
      { payload: {} },
    );

    expect(result).toMatchObject({ code: "INTEGRATION_ACTION_FAILED" });
  });
});
