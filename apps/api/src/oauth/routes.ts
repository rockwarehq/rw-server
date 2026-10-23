import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { appConfig, mcpConfig } from "../config.js";
import { redirectWith, signAuthorizationRequest } from "./request.js";
import {
  exchangeCode,
  findClient,
  isAllowedRedirectUri,
  OAUTH_SCOPES,
  normalizeScopes,
  redirectUriMatches,
  refreshTokens,
  registerClient,
  revokeGrant,
  type TokenError,
} from "./store.js";
import { hashToken } from "@rw/auth/secrets";
import prisma from "@rw/db";

// OAuth 2.1 authorization server for agents connecting over MCP, per the MCP
// authorization spec: protected-resource + authorization-server metadata,
// dynamic client registration, the authorization code flow with PKCE (S256
// only, public clients only) and refresh rotation. The person approves on
// IMM's consent page (/oauth/authorize there); this server never renders UI.

/** The API's public origin: configured, or as the caller reached us. */
export function apiOrigin(request: FastifyRequest): string {
  if (mcpConfig.publicUrl) return mcpConfig.publicUrl.replace(/\/$/, "");
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(",")[0] ?? request.protocol;
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host;
  return `${proto}://${host}`;
}

export function protectedResourceMetadataUrl(request: FastifyRequest): string {
  return `${apiOrigin(request)}/.well-known/oauth-protected-resource`;
}

function protectedResourceMetadata(request: FastifyRequest) {
  const origin = apiOrigin(request);
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Rockware",
  };
}

function authorizationServerMetadata(request: FastifyRequest) {
  const origin = apiOrigin(request);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...OAUTH_SCOPES],
    // Every authorization response names its issuer (RFC 9207); ChatGPT checks it.
    authorization_response_iss_parameter_supported: true,
  };
}

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const authorizeQuerySchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().optional(),
});

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.status(status).header("cache-control", "no-store").send({ error, error_description: description });
}

function tokenReply(reply: FastifyReply, result: Awaited<ReturnType<typeof exchangeCode>>) {
  if ("error" in result) return oauthError(reply, 400, (result as TokenError).error, result.description);
  return reply
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .send({
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: result.scopes.join(" "),
    });
}

function bodyParams(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}

async function handleAuthorize(request: FastifyRequest, reply: FastifyReply) {
  const parsed = authorizeQuerySchema.safeParse(request.query);
  if (!parsed.success) return oauthError(reply, 400, "invalid_request", "Malformed authorization request");
  const query = parsed.data;

  // Until the client and its redirect URI check out, errors can't be sent
  // back to the agent: answering an unverified redirect is an open redirect.
  const client = query.client_id ? await findClient(query.client_id) : null;
  if (!client) return oauthError(reply, 400, "invalid_client", "Unknown client_id");
  if (!query.redirect_uri || !redirectUriMatches(client.redirectUris, query.redirect_uri)) {
    return oauthError(reply, 400, "invalid_request", "redirect_uri is not registered for this client");
  }

  const fail = (error: string, description: string) =>
    reply.redirect(
      redirectWith(query.redirect_uri as string, {
        error,
        error_description: description,
        state: query.state ?? null,
        iss: apiOrigin(request),
      }),
    );
  if (query.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code");
  if (!query.code_challenge || query.code_challenge_method !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }

  const requested = query.scope ? query.scope.split(/\s+/).filter(Boolean) : [];
  const handle = signAuthorizationRequest({
    clientId: client.id,
    redirectUri: query.redirect_uri,
    codeChallenge: query.code_challenge,
    state: query.state ?? null,
    scopes: normalizeScopes(requested),
    issuer: apiOrigin(request),
  });
  const consent = new URL("/oauth/authorize", appConfig.baseUrl);
  consent.searchParams.set("request", handle);
  return reply.redirect(consent.toString());
}

async function handleToken(request: FastifyRequest, reply: FastifyReply) {
  const params = bodyParams(request.body);
  const clientId = params.client_id;
  if (!clientId || !(await findClient(clientId))) {
    return oauthError(reply, 401, "invalid_client", "Unknown client_id");
  }
  if (params.grant_type === "authorization_code") {
    if (!params.code || !params.redirect_uri || !params.code_verifier) {
      return oauthError(reply, 400, "invalid_request", "code, redirect_uri and code_verifier are required");
    }
    return tokenReply(
      reply,
      await exchangeCode({
        code: params.code,
        clientId,
        redirectUri: params.redirect_uri,
        codeVerifier: params.code_verifier,
      }),
    );
  }
  if (params.grant_type === "refresh_token") {
    if (!params.refresh_token) return oauthError(reply, 400, "invalid_request", "refresh_token is required");
    return tokenReply(reply, await refreshTokens({ refreshToken: params.refresh_token, clientId }));
  }
  return oauthError(reply, 400, "unsupported_grant_type", "Use authorization_code or refresh_token");
}

// RFC 7009: revoking either token ends the whole connection. Always 200, so
// it says nothing about whether the token existed.
async function handleRevoke(request: FastifyRequest, reply: FastifyReply) {
  const params = bodyParams(request.body);
  if (params.token) {
    const record = await prisma.oAuthToken.findUnique({
      where: { tokenHash: hashToken(params.token) },
      select: { grantId: true, grant: { select: { clientId: true } } },
    });
    if (record && record.grant.clientId === params.client_id) {
      await revokeGrant(record.grantId);
    }
  }
  return reply.status(200).send();
}

export function registerOAuthRoutes(server: FastifyInstance) {
  void server.register(async (instance) => {
    // Token and revocation requests are form-encoded (RFC 6749).
    instance.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16 * 1024 },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      },
    );

    instance.get("/.well-known/oauth-protected-resource", async (request) => protectedResourceMetadata(request));
    instance.get("/.well-known/oauth-protected-resource/mcp", async (request) => protectedResourceMetadata(request));
    instance.get("/.well-known/oauth-authorization-server", async (request) => authorizationServerMetadata(request));

    instance.post(
      "/oauth/register",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const parsed = registrationSchema.safeParse(request.body);
        if (!parsed.success) {
          return oauthError(reply, 400, "invalid_client_metadata", "redirect_uris are required");
        }
        const body = parsed.data;
        if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
          return oauthError(reply, 400, "invalid_client_metadata", "Only public clients (auth method none)");
        }
        const bad = body.redirect_uris.find((uri) => !isAllowedRedirectUri(uri));
        if (bad) {
          return oauthError(reply, 400, "invalid_redirect_uri", "Redirect URIs must be https or loopback http");
        }
        const client = await registerClient({
          name: body.client_name ?? "Unnamed agent",
          redirectUris: body.redirect_uris,
        });
        return reply.status(201).send({
          client_id: client.id,
          client_name: client.name,
          redirect_uris: client.redirectUris,
          client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      },
    );

    instance.get("/oauth/authorize", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, handleAuthorize);
    instance.post("/oauth/token", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, handleToken);
    instance.post("/oauth/revoke", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, handleRevoke);
  });
}
