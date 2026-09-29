import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { supportIdentitySignature } from "../src/services/account/user/support-identity.js";

describe("supportIdentitySignature", () => {
  it("is HMAC-SHA256(secret, email) as hex — Beacon Secure Mode's signature", () => {
    const expected = createHmac("sha256", "beacon-secret").update("pat@plant.test").digest("hex");
    expect(supportIdentitySignature("pat@plant.test", "beacon-secret")).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is null without a secret, so the client never claims an unverified email", () => {
    expect(supportIdentitySignature("pat@plant.test", "")).toBeNull();
  });
});
