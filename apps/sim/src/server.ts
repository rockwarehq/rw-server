import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { SimAuth, type SimUser } from "./auth.js";
import { stationSimSchema } from "./config.js";
import type { SimEngine } from "./engine.js";

// The page lives beside src/ and dist/, so one relative path serves both tsx and node.
const INDEX_HTML = fileURLToPath(new URL("../public/index.html", import.meta.url));

const signedIn = new WeakMap<object, SimUser>();

const loginSchema = z.object({ email: z.string().min(1), password: z.string().min(1) });

export function createServer(engine: SimEngine, options: { apiUrl: string }): FastifyInstance {
  // Behind Fly's proxy: trust X-Forwarded-* so cookies get Secure over https.
  const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: true });
  const auth = new SimAuth(options.apiUrl, () => engine.workspaceIds());

  // Everything under /api drives real tags — signed-in users of the stations' workspace only.
  server.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const user = await auth.authenticate(req, reply);
    if (!user) return reply.code(401).send({ error: "Sign in required" });
    signedIn.set(req, user);
  });

  server.get("/healthz", async () => ({ ok: true }));

  // The page itself carries no data; it shows the sign-in form until /api/session succeeds.
  server.get("/", async (_req, reply) => {
    reply.type("text/html").send(await readFile(INDEX_HTML, "utf8"));
  });

  server.post("/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Email and password are required" });
    const user = await auth.login(req, reply, parsed.data.email, parsed.data.password);
    if (!user) return reply.code(401).send({ error: "Wrong email or password, or no access to these stations" });
    return { user };
  });

  server.post("/auth/logout", async (req, reply) => {
    await auth.logout(req, reply);
    return { ok: true };
  });

  server.get("/api/session", async (req) => ({ user: signedIn.get(req) ?? null }));

  server.get("/api/stations", async () => ({ data: engine.views(), now: new Date().toISOString() }));

  server.put<{ Params: { id: string } }>("/api/stations/:id", async (req, reply) => {
    if (!engine.station(req.params.id)) return reply.code(404).send({ error: "unknown station" });
    const parsed = stationSimSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    await engine.config.setStation(req.params.id, parsed.data);
    engine.applyStation(req.params.id);
    return { data: parsed.data };
  });

  return server;
}
