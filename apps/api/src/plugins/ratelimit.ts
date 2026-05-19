import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { securityConfig } from "../config.js";

/**
 * Configure rate limiting for the application.
 *
 * Default: 100 requests per minute per IP
 * Sensitive endpoints: 5 requests per minute per IP
 *
 * Routes can override by setting config.rateLimit in their schema.
 */
export default async function rateLimitPlugin(fastify: FastifyInstance) {
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
    // Custom error response
    errorResponseBuilder: (_request, context) => ({
      error: "Too many requests",
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });
}

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
