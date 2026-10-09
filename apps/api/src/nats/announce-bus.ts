import { deriveAnnounceSubject } from "@rw/runtime/announce-subjects";
import { announcements } from "@rw/services/device/gateway/index";
import { moduleLogger } from "../logger.js";
import { getNatsConnection } from "./util.js";

const log = moduleLogger("announce-bus");

const encoder = new TextEncoder();

// Announcements go out over core NATS (no stream): the gateway's leaf carries
// them down its outbound connection, and one sent while the gateway is offline
// is dropped rather than spoken late.
export async function startAnnounceBus(): Promise<() => Promise<void>> {
  const nc = await getNatsConnection();
  if (!nc) return async () => {};

  announcements.setAnnouncementSink((gatewayId, message) => {
    nc.publish(deriveAnnounceSubject(gatewayId), encoder.encode(JSON.stringify(message)));
  });

  log.info("publishing gateway announcements");

  return async () => {
    announcements.setAnnouncementSink(null);
  };
}
