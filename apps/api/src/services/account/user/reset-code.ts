import { customAlphabet } from "nanoid";
import { hashToken } from "@rw/auth/secrets";
import { securityConfig } from "../../../config.js";

// Numeric one-time code typed by the user (e.g. "483920"). Low entropy by
// design — brute force is bounded by the per-code attempt cap and short
// expiry, not by the code space.
const generateDigits = customAlphabet("0123456789", securityConfig.resetCodeLength);

export function generateResetCode(): { plaintext: string; hash: string } {
  const plaintext = generateDigits();
  return { plaintext, hash: hashToken(plaintext) };
}

/** Strip everything but digits so "483 920" and "483-920" both work. */
export function normalizeResetCode(input: string): string {
  return input.replace(/\D/g, "");
}
