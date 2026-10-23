import { createSigner, createVerifier } from "fast-jwt";
import { authEnv, deriveSigningKey } from "@rw/auth/env";

// The authorization request travels from GET /oauth/authorize to IMM's
// consent page and back to agentConnection.approve as a signed handle, so the
// server keeps no state for requests nobody finishes. Its own audience key:
// it can never pass as an access token, nor one as it.

const AUDIENCE = "rw-oauth-request";
const TTL_MS = 10 * 60 * 1000;

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scopes: string[];
  /** Our issuer as the agent discovered it; every authorization response names it (RFC 9207). */
  issuer?: string;
}

const signer = createSigner({
  key: deriveSigningKey(AUDIENCE),
  algorithm: "HS256",
  expiresIn: TTL_MS,
  iss: authEnv.issuer,
  aud: AUDIENCE,
});

const verifier = createVerifier({
  key: deriveSigningKey(AUDIENCE),
  algorithms: ["HS256"],
  allowedIss: authEnv.issuer,
  allowedAud: AUDIENCE,
});

export function signAuthorizationRequest(request: AuthorizationRequest): string {
  return signer({ req: request });
}

/** The request, or null when the handle is forged, tampered with or expired. */
export function verifyAuthorizationRequest(handle: string): AuthorizationRequest | null {
  try {
    const payload = verifier(handle) as { req?: AuthorizationRequest };
    return payload.req ?? null;
  } catch {
    return null;
  }
}

/** Where the agent goes back to: its redirect URI with these params added. */
export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}
