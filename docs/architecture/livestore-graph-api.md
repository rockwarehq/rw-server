# Livestore Graph API — Auth & Protocol Contract

The livestore service exposes read access to the graph over HTTP and live
values over WebSocket. Every data endpoint requires authentication; only the
health probes (`/health`, `/healthz`, `/readyz`) are public.

## Credentials

| Credential | Who | Transport |
|---|---|---|
| User access JWT | IMM / console users (browser) | `Authorization: Bearer <jwt>` on HTTP; `{op:"auth"}` first message on WS |
| Display access JWT | Kiosk displays | same as users |
| API token (`rw_app_...`) | 3rd-party server apps | `Authorization: Bearer rw_app_...` on HTTP and on the WS upgrade request |

- API tokens are minted via the `apiToken.create` RPC on the api service
  (requires `settings:admin`). The plaintext token is returned **exactly once**
  at creation. Tokens are bound to one workspace + one site and are read-only.
- User JWTs must carry a `siteId` claim (issued on login/refresh/site-switch).
  A token without site context is rejected with 401.
- All data is scoped to the credential's site. Cross-site node fetches return
  404 (indistinguishable from missing); cross-site property subscriptions are
  rejected with `FORBIDDEN`.

## HTTP endpoints

| Route | Auth | Response |
|---|---|---|
| `GET /graph/nodes` | required | `{ data: Node[] }` — only the principal's site |
| `GET /graph/nodes/:id` | required | node, or 404 if missing/cross-site |
| `GET /health`, `/healthz`, `/readyz` | none | probe status only |

Auth failures always return `401 { "error": "unauthorized" }` with no
distinction between missing, malformed, expired, or revoked credentials.

## WebSocket: `/graph/live`

> `/ws/graph` remains as a deprecated alias with identical behavior so
> existing clients can migrate independently; it will be removed once client
> traffic has moved. Use `/graph/live` for all new integrations.

### Handshake

1. **Server clients**: send `Authorization: Bearer <token>` on the upgrade
   request; the server authenticates immediately.
2. **Browsers** (cannot set WS headers): the connection starts
   unauthenticated. Send as the first message, within **10 seconds**:

   ```json
   { "op": "auth", "token": "<access JWT or rw_app_ token>" }
   ```

   Any other op first, an invalid token, or timeout → the server sends
   `{ "op": "error", "error": "...", "code": "UNAUTHORIZED" }` and closes with
   code **4401**.
3. On success the server sends:

   ```json
   { "op": "ready", "siteId": "<site-uuid>", "authExpiresAt": 1234567890000 }
   ```

   `authExpiresAt` is epoch-ms for JWT principals, `null` for API tokens.
   Do not subscribe before `ready`.

Never place tokens in the URL query string — they end up in proxy and server
logs.

### Ops

Client → server:

```json
{ "op": "subscribe",   "propertyIds": ["<uuid>", ...] }
{ "op": "unsubscribe", "propertyIds": ["<uuid>", ...] }
{ "op": "auth",        "token": "<fresh token>" }
```

Server → client:

```json
{ "op": "value", "propertyId": "<uuid>", "envelope": { ... } }
{ "op": "ready", "siteId": "...", "authExpiresAt": <ms|null> }
{ "op": "auth_expiring" }
{ "op": "error", "error": "<text>", "code": "<CODE>", "propertyIds": [ ... ] }
```

Subscribes are partial-success: authorized ids stream values; unknown and
cross-site ids (deliberately indistinguishable) are reported together in one
`FORBIDDEN` error carrying the rejected `propertyIds`.

### Session lifetime

- **JWT principals**: the server sends `{"op":"auth_expiring"}` 60 s before
  token expiry. Send a fresh `{"op":"auth"}` (same site) to keep the
  connection; otherwise it closes with `AUTH_EXPIRED` / 4401 60 s after
  expiry. Re-auth onto a different site is refused with `SITE_MISMATCH`.
- **API tokens**: revalidated server-side every 60 s; a revoked/expired token
  closes the connection with `AUTH_EXPIRED` / 4401 (worst-case ~90 s after
  revocation, including the 30 s validation cache).
- On any 4401 close: obtain a fresh credential, reconnect, re-auth, and replay
  subscriptions. `ReconnectingGraphSocket` (`@rw/livestore/client/*`) does all
  of this when given a `getToken` callback.

### Error codes

| `code` | Meaning |
|---|---|
| `UNAUTHORIZED` | No/invalid credential (also closes 4401) |
| `AUTH_EXPIRED` | Credential expired or revoked mid-connection (closes 4401) |
| `SITE_MISMATCH` | Re-auth attempted with a different site's credential |
| `FORBIDDEN` | Subscribe contained unknown/cross-site propertyIds |
| `RATE_LIMITED` | Op token bucket exhausted (10 ops/s, burst 30) |
| `SUBSCRIPTION_LIMIT` | Over 1000 active subscriptions on the connection |
| `INVALID_MESSAGE` | Unparseable message or too many ids (max 1000/message) |

### Connection limits

- Max inbound message: 64 KB (violation closes 1009)
- Heartbeat: server pings every 30 s; two missed pongs terminate the socket
- Op rate: 10/s sustained, burst 30

## Deployment notes

- Livestore requires `JWT_SECRET` (same value as the api app) at boot;
  production refuses to start without it.
- `/metrics` listens on a separate private port (`METRICS_PORT`, default 9091)
  that fly-proxy does not route; it is unreachable from the internet.
