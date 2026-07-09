import { z } from "zod";

// All environment access lives here. The schema is parsed once at module load,
// so a misconfigured process dies with one aggregated error before
// server.listen — same fail-fast pattern as packages/auth/src/env.ts
// (which owns JWT_SECRET validation).
const isProduction = process.env.NODE_ENV === "production";

// Required in production, optional (with local-dev defaults applied below) otherwise.
const prodRequired = (schema: z.ZodString) => (isProduction ? schema : schema.optional());

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
  NODE_ID: z.string().default("gateway-001"),
  PORT: z.coerce.number().int().min(1).max(65535).default(30000),
  HOST: z.string().default("::"),
  CLOSE_GRACE_DELAY: z.coerce.number().int().positive().default(500),

  // Infrastructure the app cannot run without in production. Both are already
  // listed in every tenant's _meta.required_secrets; validating here turns a
  // missing fly secret into an immediate, named boot failure.
  DATABASE_URL: prodRequired(z.string().min(1)),
  REDIS_URL: prodRequired(z.string().startsWith("redis")),

  // Browser-facing base URL (email links, CORS allowlist). Set per-tenant in
  // apps/api/fly/tenants/*.toml.
  APP_BASE_URL: isProduction ? z.url({ protocol: /^https$/ }) : z.url().default("http://localhost:3000"),
  // Extra allowed browser origins (comma-separated), additive to APP_BASE_URL.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  PROCESSOR_SHARED_SECRET: isProduction ? z.string().min(16) : z.string().default(""),
  PROCESSOR_CACHE_REFRESH_URL: z.string().default(""),
  PROCESSOR_CACHE_REFRESH_SECRET: z.string().optional(),
  PROCESSOR_CACHE_REFRESH_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  // Optional-by-design: each feature degrades cleanly when unset (publishers
  // log "disabled", emailConfig.enabled / storageConfig.enabled gate usage).
  NATS_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("noreply@notify.rockware.io"),
  BUCKET_NAME: z.string().optional(),
  AWS_REGION: z.string().default("auto"),
  AWS_ENDPOINT_URL_S3: z.string().default("https://fly.storage.tigris.dev"),
  AWS_ACCESS_KEY_ID: z.string().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().default(""),
  DOCUMENT_MAX_FILE_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  DOCUMENT_ALLOWED_CONTENT_TYPES: z.string().optional(),

  NATS_GATEWAY_RELAY_SERVERS: z.string().default(""),
  NATS_GATEWAY_RELAY_USER: z.string().optional(),
  NATS_GATEWAY_RELAY_PASS: z.string().optional(),

  STATION_ACTION_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
}
const config = parsed.data;

export const env = {
  nodeId: config.NODE_ID,
  isDevelopment: !isProduction,
  logLevel: config.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
};

export const infraConfig = {
  databaseUrl: config.DATABASE_URL,
  redisUrl: config.REDIS_URL,
  natsUrl: config.NATS_URL,
};

export const serverConfig = {
  port: config.PORT,
  // Bind to IPv6 wildcard '::' for dual-stack — Linux's IPV6_V6ONLY=0
  // default makes this accept both IPv4 and IPv6 connections. Binding to
  // '0.0.0.0' would accept IPv4 only, which breaks cross-app traffic on
  // fly's 6PN network (apps reach each other by IPv6 via <app>.internal).
  host: config.HOST,
  graceDelay: config.CLOSE_GRACE_DELAY, // milliseconds
};

export const corsConfig = {
  // Dev with no explicit allowlist keeps reflecting any origin (local web
  // dev on arbitrary ports). Production is always an exact-match list —
  // APP_BASE_URL is required there, so the list is never empty.
  origins:
    !isProduction && !config.CORS_ALLOWED_ORIGINS
      ? (true as const)
      : [
          config.APP_BASE_URL,
          ...(config.CORS_ALLOWED_ORIGINS ?? "")
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
        ],
};

export const emailConfig = {
  apiKey: config.RESEND_API_KEY ?? "",
  fromAddress: config.EMAIL_FROM,
  baseUrl: config.APP_BASE_URL,
  enabled: !!config.RESEND_API_KEY,
};

export const securityConfig = {
  // Token expiry
  inviteTokenExpiryMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  resetTokenExpiryMs: 60 * 60 * 1000, // 1 hour

  // Brute-force protection
  maxTokenAttempts: 5, // Invalidate token after this many failed attempts
  maxLoginAttempts: 5, // Lock account after this many failed attempts
  loginLockoutMs: 15 * 60 * 1000, // 15 minutes

  // Rate limiting (requests per minute)
  rateLimitSensitive: 5, // For login, invite, reset endpoints
  rateLimitRefresh: 30, // For token refresh (rotated, DB-backed — see plugins/ratelimit.ts)
  rateLimitDefault: 100, // For general API endpoints
};

export const processorConfig = {
  sharedSecret: config.PROCESSOR_SHARED_SECRET ?? "",
  cacheRefreshUrl: config.PROCESSOR_CACHE_REFRESH_URL,
  cacheRefreshSecret: config.PROCESSOR_CACHE_REFRESH_SECRET ?? config.PROCESSOR_SHARED_SECRET ?? "",
  cacheRefreshTimeoutMs: config.PROCESSOR_CACHE_REFRESH_TIMEOUT_MS,
};

export const stationActionConfig = {
  webhookTimeoutMs: config.STATION_ACTION_WEBHOOK_TIMEOUT_MS,
};

// Re-exported from the shared runtime package.
export { bullmqConfig } from "@rw/runtime/bullmq-config";

// NATS relay credentials handed to a gateway in the /edge/connect response.
// The gateway connects its local leaf node out to the cloud cluster using
// these and publishes tags.> over the leaf. Single shared user/pass for now
// (see gateway applyNatsCredentials, which expects { servers, user, pass }).
export const gatewayNatsConfig = {
  servers: config.NATS_GATEWAY_RELAY_SERVERS.split(",")
    .map((server) => server.trim())
    .filter(Boolean),
  user: config.NATS_GATEWAY_RELAY_USER,
  pass: config.NATS_GATEWAY_RELAY_PASS,
};

export const storageConfig = {
  bucketName: config.BUCKET_NAME ?? "",
  region: config.AWS_REGION,
  endpoint: config.AWS_ENDPOINT_URL_S3,
  accessKeyId: config.AWS_ACCESS_KEY_ID,
  secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  enabled: !!config.BUCKET_NAME,

  // Limits
  maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
  maxPicturesPerProduct: 10,
  allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"],
  maxDocumentFileSizeBytes: config.DOCUMENT_MAX_FILE_SIZE_BYTES,
  allowedDocumentContentTypes: config.DOCUMENT_ALLOWED_CONTENT_TYPES
    ? config.DOCUMENT_ALLOWED_CONTENT_TYPES.split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json",
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/svg+xml",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],

  // URL expiry
  presignedUrlExpirySeconds: 3600, // 1 hour
};
