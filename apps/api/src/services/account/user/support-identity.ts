import { createHmac } from "node:crypto";
import { supportConfig } from "../../../config.js";

/*
 * Support-widget identity verification. Chatwoot's identity validation takes
 * the contact identifier (our user id) plus HMAC-SHA256(secret, identifier) as
 * hex (identifier_hash), and rejects the identity unless they match. The
 * secret never leaves the server; without it the signature is null. The user
 * id rather than the email is signed so a changed email doesn't split the
 * contact's history. Vendor-neutral on purpose: switching widgets needs no API
 * change.
 */
export function supportIdentitySignature(identifier: string, secret = supportConfig.identitySecret): string | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update(identifier).digest("hex");
}
