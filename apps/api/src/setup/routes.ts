import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { MAX_UPLOAD_BYTES, receiveUpload } from "./uploads.js";

// PUT /setup/uploads/:id: the file for a setup import, sent with the upload's
// one-time token in x-upload-token. Any content type is taken as raw bytes,
// so `curl -T file.csv` and `--data-binary @file.csv` both work.

const params = z.object({ id: z.uuid() });

export function registerSetupUploadRoutes(server: FastifyInstance) {
  void server.register(async (instance) => {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_request, body, done) => {
      done(null, body);
    });

    instance.put(
      "/setup/uploads/:id",
      { bodyLimit: MAX_UPLOAD_BYTES, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const parsed = params.safeParse(request.params);
        if (!parsed.success) return reply.status(404).send({ error: "No such upload." });
        const token = request.headers["x-upload-token"];
        if (typeof token !== "string" || !token) {
          return reply.status(401).send({ error: "Send the upload token in the x-upload-token header." });
        }
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        if (body.byteLength === 0) return reply.status(400).send({ error: "The request had no file in it." });
        const result = await receiveUpload(parsed.data.id, token, body);
        if (!result.ok) return reply.status(result.status).send({ error: result.message });
        return reply.send({ ok: true, size: result.size });
      },
    );
  });
}
