import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { frontChatUserHash } from "../src/services/account/user/front-chat.js";

describe("frontChatUserHash", () => {
  it("is HMAC-SHA256(secret, email) as hex — Front's identity verification", () => {
    const expected = createHmac("sha256", "front-secret").update("pat@plant.test").digest("hex");
    expect(frontChatUserHash("pat@plant.test", "front-secret")).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is null without a secret, so the client never claims an unverified email", () => {
    expect(frontChatUserHash("pat@plant.test", "")).toBeNull();
  });
});
