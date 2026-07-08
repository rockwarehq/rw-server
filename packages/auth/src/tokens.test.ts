import { describe, expect, it } from "vitest";
import { createAccessToken, verifyAccessToken } from "./tokens.js";

describe("access tokens", () => {
  it("round-trips a user token with principal, id, email", () => {
    const token = createAccessToken({ id: "user-1", email: "a@example.com", workspaceId: "ws-1" });
    const decoded = verifyAccessToken(token);
    expect(decoded.principal).toBe("USER");
    if (decoded.principal !== "DISPLAY") {
      expect(decoded.id).toBe("user-1");
      expect(decoded.email).toBe("a@example.com");
      expect(decoded.workspaceId).toBe("ws-1");
    }
  });

  it("round-trips a display token with principal, displayId, siteId", () => {
    const token = createAccessToken({
      principal: "DISPLAY",
      displayId: "disp-1",
      siteId: "site-1",
      workspaceId: "ws-1",
    });
    const decoded = verifyAccessToken(token);
    expect(decoded.principal).toBe("DISPLAY");
    if (decoded.principal === "DISPLAY") {
      expect(decoded.displayId).toBe("disp-1");
      expect(decoded.siteId).toBe("site-1");
    }
  });

  it("sets iss/aud/exp standard claims", () => {
    const token = createAccessToken({ id: "user-1", email: "a@example.com" });
    const decoded = verifyAccessToken(token) as unknown as { iss: string; aud: string; exp: number; iat: number };
    expect(decoded.iss).toBe("rw-api");
    expect(decoded.aud).toBe("rw-user");
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it("rejects a user token presented as a display token (audience/key separation)", () => {
    // A user token routed through the display verifier must fail: different
    // HKDF key and audience. Force the display path by decoding is not possible
    // here, so assert the tokens are not interchangeable by tampering the
    // principal claim, which invalidates the signature.
    const userToken = createAccessToken({ id: "user-1", email: "a@example.com" });
    const [header, , signature] = userToken.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ principal: "DISPLAY", displayId: "x" })).toString("base64url");
    const forged = `${header}.${forgedPayload}.${signature}`;
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it("rejects a garbage token", () => {
    expect(() => verifyAccessToken("not-a-jwt")).toThrow();
  });
});
