import { createHmac } from "node:crypto";
import { frontChatConfig } from "../../../config.js";

/*
 * Front Chat identity verification: the widget sends the viewer's email with
 * HMAC-SHA256(verification secret, email) as hex, and Front rejects the
 * identity unless they match. The secret never leaves the server; without it
 * the hash is null and the client runs the chat anonymously rather than
 * claiming an unverified email.
 */
export function frontChatUserHash(email: string, secret = frontChatConfig.verificationSecret): string | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update(email).digest("hex");
}
