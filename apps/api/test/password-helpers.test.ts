import { describe, expect, it } from "vitest";
import { hashToken } from "@rw/auth/secrets";
import { generateStrongPassword } from "../src/services/account/user/password.js";
import { generateResetCode, normalizeResetCode } from "../src/services/account/user/reset-code.js";
import { validatePasswordStrength } from "../src/services/validation.js";

// Tier 1: pure helpers, no infrastructure.
describe("password helpers", () => {
  it("generateResetCode returns 6 digits and a matching hash", () => {
    for (let i = 0; i < 20; i++) {
      const { plaintext, hash } = generateResetCode();
      expect(plaintext).toMatch(/^\d{6}$/);
      expect(hash).toBe(hashToken(plaintext));
    }
  });

  it("normalizeResetCode strips separators and other non-digits", () => {
    expect(normalizeResetCode("483 920")).toBe("483920");
    expect(normalizeResetCode("483-920")).toBe("483920");
    expect(normalizeResetCode("483920")).toBe("483920");
    expect(normalizeResetCode("abc")).toBe("");
  });

  it("generateStrongPassword always satisfies the strength policy", () => {
    for (let i = 0; i < 50; i++) {
      const password = generateStrongPassword();
      expect(password).toHaveLength(16);
      expect(validatePasswordStrength(password).valid).toBe(true);
    }
  });
});
