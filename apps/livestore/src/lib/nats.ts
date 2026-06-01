import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";

export interface LivestoreNatsClient {
  connection: NatsConnection;
  jetstream: JetStreamClient;
  jetstreamManager: JetStreamManager;
}

let client: LivestoreNatsClient | null = null;

function natsServers(): string | string[] {
  const configured = process.env.NATS_URL || "nats://127.0.0.1:4222";
  const servers = configured
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);

  return servers.length === 1 ? servers[0]! : servers;
}

export function isNatsReady(): boolean {
  return client !== null && !client.connection.isClosed();
}

export function getNatsClient(): LivestoreNatsClient {
  if (!client) {
    throw new Error("NATS client is not ready");
  }
  return client;
}

export async function startNats(): Promise<LivestoreNatsClient> {
  if (client) return client;

  const connection = await connect({
    servers: natsServers(),
    name: process.env.NATS_CLIENT_NAME || "livestore",
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });

  client = {
    connection,
    jetstream: jetstream(connection),
    jetstreamManager: await jetstreamManager(connection),
  };

  console.log(`[livestore] connected to NATS at ${connection.getServer()}`);

  connection.closed().then((err: Error | void) => {
    client = null;
    if (err) {
      console.error("[livestore] NATS connection closed with error:", err);
      return;
    }
    console.log("[livestore] NATS connection closed");
  });

  return client;
}

export async function stopNats(): Promise<void> {
  const current = client;
  client = null;
  if (!current || current.connection.isClosed()) return;
  await current.connection.drain();
}
