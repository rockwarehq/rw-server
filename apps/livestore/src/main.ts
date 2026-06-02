import http from "node:http";
import { ensureMqttIngestStream } from "./lib/jetstream.js";
import { ensureHealthKvBucket } from "./lib/kv.js";
import { isMqttReady, startMqttBridge, stopMqttBridge } from "./lib/mqtt.js";
import { isNatsReady, startNats, stopNats } from "./lib/nats.js";

process.env.TZ = "UTC";

const port = Number.parseInt(process.env.PORT ?? "", 10) || 9470;
const host = process.env.HOST || "::";

let healthy = true;
let shuttingDown = false;
let natsStart: Promise<unknown> | null = null;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    const status = healthy ? 200 : 503;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: healthy, service: "livestore" }));
    return;
  }

  if (req.method === "GET" && req.url === "/readyz") {
    const ready = !shuttingDown && isNatsReady() && isMqttReady();
    const status = ready ? 200 : 503;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: ready, mqtt: isMqttReady(), nats: isNatsReady(), service: "livestore" }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, host, () => {
  console.log(`[livestore] listening on [${host}]:${port}`);
});

function start(): void {
  natsStart = startNats()
    .then(async () => {
      await ensureMqttIngestStream();
      await ensureHealthKvBucket();
      await startMqttBridge();
    })
    .catch((err) => {
      console.error("[livestore] failed to start:", err);
    });
}

function shutdown(): void {
  shuttingDown = true;
  healthy = false;
  server.close((err) => {
    if (err) {
      console.error("[livestore] failed to close:", err);
      process.exit(1);
    }
    Promise.resolve(natsStart)
      .then(() => stopMqttBridge())
      .then(() => stopNats())
      .then(() => process.exit(0))
      .catch((shutdownErr) => {
        console.error("[livestore] failed to stop cleanly:", shutdownErr);
        process.exit(1);
      });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
