// NATS subject + message for spoken announcements on on-prem gateways.
//
//   announce.<gatewayId>   text to speak (cloud -> gw) — core NATS, no stream
//
// Core on purpose: an announcement published while the gateway is offline is
// dropped rather than spoken late ("Machine 226 is down" an hour after it is back
// up). The gateway mirrors the subject in rw-gateway/src/subjects.ts and parses
// the message in rw-gateway/src/announcer/announcer.ts, where every field but
// `text` is optional and an invalid one falls back to the gateway's default.

import { sanitizeSubjectToken } from "./domain-events.js";

export function deriveAnnounceSubject(gatewayId: string): string {
  const token = sanitizeSubjectToken(gatewayId);
  if (!token) throw new Error("gatewayId must produce a non-empty NATS subject token");
  return `announce.${token}`;
}

export interface AnnouncementMessage {
  /** The gateway speaks a given id once, so a redelivered event can't repeat it. */
  id?: string;
  text: string;
  /** Gateway voice name ("default", or a site name from its config) or an engine voice id. */
  voice?: string;
  /** 0.5–2, 1 = normal. */
  speed?: number;
  /** true = the gateway's chime, false = none, or a chime name. Omitted = the gateway's default. */
  chimeBefore?: boolean | string;
  chimeAfter?: boolean | string;
  /** Times to speak the text, 1–10. */
  repeat?: number;
  /**
   * normal waits its turn; high plays ahead of queued normal ones; emergency stops
   * whatever the gateway is playing (unless it is also an emergency) and plays next.
   */
  priority?: "normal" | "high" | "emergency";
  /** Epoch ms after which the gateway drops it unspoken (default 60s after arrival). */
  expiresAt?: number;
}
