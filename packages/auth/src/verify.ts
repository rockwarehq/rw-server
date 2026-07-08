import { createDecoder, createSigner, createVerifier, TokenError } from "fast-jwt";
import { authEnv, deriveSigningKey } from "./env.js";

// JWT signing/verification only — deliberately free of any @rw/db import so
// services with their own Prisma client (e.g. livestore) can verify access
// tokens without pulling in the shared prisma singleton and opening a second
// connection pool. DB-backed token functions live in ./tokens.ts, which
// re-exports everything here for existing importers.

export const ACCESS_TOKEN_EXPIRY = 15 * 60 * 1000; // 15 minutes

export interface AccessTokenPayload {
  principal?: "USER";
  id: string;
  email: string;
  workspaceId?: string;
  siteId?: string;
}

export interface DisplayAccessTokenPayload {
  principal: "DISPLAY";
  displayId: string;
  siteId: string;
  workspaceId: string;
}

export type AnyAccessTokenPayload = AccessTokenPayload | DisplayAccessTokenPayload;

export type DecodedAccessToken = AnyAccessTokenPayload & {
  iat: number;
  exp: number;
};

// Each principal audience signs/verifies with its own HKDF-derived key, pins
// HS256 (no algorithm confusion), and enforces issuer + audience + expiry.
const userAccessSigner = createSigner({
  key: deriveSigningKey(authEnv.userAudience),
  algorithm: "HS256",
  expiresIn: ACCESS_TOKEN_EXPIRY,
  iss: authEnv.issuer,
  aud: authEnv.userAudience,
});

const displayAccessSigner = createSigner({
  key: deriveSigningKey(authEnv.displayAudience),
  algorithm: "HS256",
  expiresIn: ACCESS_TOKEN_EXPIRY,
  iss: authEnv.issuer,
  aud: authEnv.displayAudience,
});

const userAccessVerifier = createVerifier({
  key: deriveSigningKey(authEnv.userAudience),
  algorithms: ["HS256"],
  allowedIss: authEnv.issuer,
  allowedAud: authEnv.userAudience,
  clockTolerance: authEnv.clockToleranceMs,
});

const displayAccessVerifier = createVerifier({
  key: deriveSigningKey(authEnv.displayAudience),
  algorithms: ["HS256"],
  allowedIss: authEnv.issuer,
  allowedAud: authEnv.displayAudience,
  clockTolerance: authEnv.clockToleranceMs,
});

// Reads the (unverified) principal only to pick which verifier to run; the
// selected verifier then cryptographically enforces key/aud/iss/alg/exp, so a
// forged principal simply routes to a verifier whose key will reject it.
const decodeAccessToken = createDecoder();

export function createAccessToken(payload: AnyAccessTokenPayload): string {
  if (payload.principal === "DISPLAY") {
    return displayAccessSigner(payload);
  }

  return userAccessSigner({
    ...payload,
    principal: "USER",
  });
}

export function verifyAccessToken(token: string): DecodedAccessToken {
  const unverified = decodeAccessToken(token) as { principal?: string } | null;
  const verifier = unverified?.principal === "DISPLAY" ? displayAccessVerifier : userAccessVerifier;
  return verifier(token) as DecodedAccessToken;
}

// True when verification failed only because the token is past its expiry (a
// normal "please refresh" case) rather than malformed or wrongly signed (which
// is worth flagging as suspicious). Never pass the token itself to logs.
export function isExpiredTokenError(err: unknown): boolean {
  return err instanceof TokenError && err.code === TokenError.codes.expired;
}
