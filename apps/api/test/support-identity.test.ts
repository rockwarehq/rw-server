import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { supportIdentitySignature } from "../src/services/account/user/support-identity.js";

const USER_ID = "3f1c6a52-0b7e-4d8a-9a51-5c2d1e7f9b10";

describe("supportIdentitySignature", () => {
  it("is HMAC-SHA256(secret, user id) as hex — Chatwoot's identifier_hash", () => {
    const expected = createHmac("sha256", "inbox-token").update(USER_ID).digest("hex");
    expect(supportIdentitySignature(USER_ID, "inbox-token")).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is null without a secret", () => {
    expect(supportIdentitySignature(USER_ID, "")).toBeNull();
  });
});
