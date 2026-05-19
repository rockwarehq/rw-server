// Tiny shared HTTP server for healthz/readyz/metrics.
// Phase 0 stub; full implementation in task #9.

import { createServer, type Server } from "node:http";

export interface HostServerOptions {
  port: number;
  isReady?: () => boolean;
  isHealthy?: () => boolean;
  getMetrics?: () => Promise<string>;
}

export interface HostServer {
  close: () => Promise<void>;
}

export function startHostServer(opts: HostServerOptions): HostServer {
  const server: Server = createServer((req, res) => {
    if (req.url === "/healthz") {
      const ok = opts.isHealthy?.() ?? true;
      res.writeHead(ok ? 200 : 503, { "content-type": "text/plain" });
      res.end(ok ? "ok" : "unhealthy");
      return;
    }
    if (req.url === "/readyz") {
      const ready = opts.isReady?.() ?? true;
      res.writeHead(ready ? 200 : 503, { "content-type": "text/plain" });
      res.end(ready ? "ready" : "not ready");
      return;
    }
    if (req.url === "/metrics" && opts.getMetrics) {
      opts.getMetrics().then((body) => {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(body);
      }).catch((err) => {
        res.writeHead(500);
        res.end(String(err));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(opts.port);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
