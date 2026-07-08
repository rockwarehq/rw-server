import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { securityConfig } from "../config.js";

/**
 * Configure rate limiting for the application.
 *
 * Default: 100 requests per minute per IP
 * Sensitive endpoints: 5 requests per minute per IP
 *
 * Routes can override by setting config.rateLimit in their schema.
 *
 * Must be wrapped in fastify-plugin: without it, @fastify/rate-limit is
 * registered inside an encapsulated child context and applies to no route
 * registered by sibling plugins (i.e. the entire API).
 */
export default fp(async function rateLimitPlugin(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    max: securityConfig.rateLimitDefault,
    timeWindow: "1 minute",
    // Use request IP as the key
    keyGenerator: (request) => request.ip,
    // Add headers to show rate limit status
    addHeadersOnExceeding: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    // Custom error response. statusCode is required — the built object is
    // thrown as the error, and without it Fastify's error handler responds 500.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "Too many requests",
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });
});

/**
 * Rate limit configuration for sensitive endpoints.
 * Use this in route config for login, invite, reset, etc.
 */
export const sensitiveRateLimit = {
  rateLimit: {
    max: securityConfig.rateLimitSensitive,
    timeWindow: "1 minute",
  },
};
