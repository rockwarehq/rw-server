import { createHmac } from "node:crypto";
import { supportConfig } from "../../../config.js";

/*
 * Support-widget identity verification. Help Scout Beacon's Secure Mode (and
 * Front Chat's, the scheme is the same) takes the viewer's email plus
 * HMAC-SHA256(secret, email) as hex, and rejects the identity unless they
 * match. The secret never leaves the server; without it the signature is null
 * and the client runs the widget anonymously rather than claiming an
 * unverified email. Vendor-neutral on purpose: switching widgets needs no API
 * change.
 */
export function supportIdentitySignature(email: string, secret = supportConfig.identitySecret): string | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update(email).digest("hex");
}
