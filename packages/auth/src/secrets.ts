import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Single source of truth for opaque-secret hashing/generation used across
// refresh tokens, display bootstrap secrets, gateway tokens, and invite/reset
// tokens. Tokens are random and high-entropy, so a plain SHA-256 at rest is
// appropriate (unlike passwords, which use bcrypt — see ./password.ts).

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// A random 256-bit secret as hex (64 chars).
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

// A random secret together with its at-rest hash, for one-time tokens that are
// handed to the client once and only ever compared by hash afterwards.
export function generateToken(): { plaintext: string; hash: string } {
  const plaintext = generateSecret();
  return { plaintext, hash: hashToken(plaintext) };
}

// Constant-time comparison of two secret strings. Both sides are hashed first
// so the comparison is length-independent and never leaks length or content
// via timing (use this for claim codes, bootstrap secrets, and hash equality).
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
