import { hkdfSync } from "node:crypto";

// Centralized, fail-fast auth configuration. Importing this module validates
// the JWT secret at process startup: in production an unset/default/weak secret
// throws immediately rather than silently signing tokens with a guessable key.

const DEV_FALLBACK_SECRET = "dev-secret-change-me";
const isProduction = process.env.NODE_ENV === "production";

function loadJwtSecret(): string {
  const raw = process.env.JWT_SECRET;
  if (isProduction) {
    if (!raw || raw === DEV_FALLBACK_SECRET || raw.length < 32) {
      throw new Error(
        "JWT_SECRET must be set to a strong value (>= 32 chars, not the dev default) when NODE_ENV=production",
      );
    }
    return raw;
  }
  return raw || DEV_FALLBACK_SECRET;
}

const jwtSecret = loadJwtSecret();

// Derive an independent signing key per principal audience from the single
// master secret via HKDF. Ops still manages one JWT_SECRET, but a token minted
// for one audience is cryptographically useless for another (a display token
// can no longer be replayed as a user token even if its claims are forged).
export function deriveSigningKey(audience: string): Buffer {
  return Buffer.from(hkdfSync("sha256", jwtSecret, "", `rw-auth:${audience}:v1`, 32));
}

export const authEnv = {
  issuer: process.env.JWT_ISSUER || "rw-api",
  // Audience labels double as the HKDF context, so they are part of the token contract.
  userAudience: "rw-user",
  displayAudience: "rw-display",
  // fast-jwt clock tolerance (ms) to absorb minor clock drift across machines.
  clockToleranceMs: 5000,
} as const;
