// Authorization coverage contract, enforced by test/policy-coverage.test.ts:
// every oRPC procedure must call authorize()/authorizeList() — or, for the
// site directory only, authorizeAccessibleSites() — INLINE in its handler
// body (not behind a local helper — the gate scans handler source), unless
// its dotted router path is listed here with a reason. Every REST route must
// carry verifyAccessToken plus either requirePermission or a policy call,
// unless listed in PUBLIC_REST_ROUTES.
//
// Adding an entry here is a code-review decision, not a default
// (ADR-0002 amendment, 2026-08-18).

export const EXCLUDED_PROCEDURES: ReadonlySet<string> = new Set([
  // ── operator.* — display-identity-bound shop-floor flows. The principal is
  // a DISPLAY whose identity is verified against the display row itself
  // (assertDisplayIdentity + resolveDisplayContext), which is stricter than
  // site scope; USER permissions are not meaningful here.
  "operator.config",
  "operator.logon",
  "operator.logoff",
  "operator.logoffAll",
  "operator.activeSessions",
  "operator.employees",
  // ── processor shared-secret surface (machine-to-machine ingest/cache).
  "events.ingest",
  "station.listEventsForProcessor",
  "station.getTagSnapshotsForProcessor",
  "station.triggerEvent",
  // ── display bootstrap — a TV registers/polls before any identity exists.
  // display.get exposes dashboard content by uuid (known trade-off);
  // heartbeat's auth check is a live TODO (race with claim flow).
  // display-context-scoped listing: the display principal's own
  // site/workcenter/station bound the query (getDisplayDocumentContext).
  "document.listForDisplayContext",
  "display.register",
  "display.get",
  "display.heartbeat",
  // ── static per-deploy catalogs with no tenant data.
  "graph.hook.eventCatalog",
  "graph.introspect.manifest",
  "integration.typeCatalog",
]);

/** Deliberately tokenless REST routes (mirrors test/anonymous-access.test.ts). */
export const PUBLIC_REST_ROUTES: ReadonlySet<string> = new Set(
  [
    "GET /health",
    "GET /healthz",
    "GET /ready",
    "GET /readyz",
    "POST /auth/login",
    "POST /auth/logout",
    "POST /auth/refresh",
    "POST /auth/display/login",
    "POST /auth/display/refresh",
    "POST /auth/display/logout",
    "POST /users/invite/verify",
    "POST /users/invite/complete",
    "POST /users/password/forgot",
    "POST /users/password/reset",
    "POST /edge/claim",
    "POST /edge/connect",
    "POST /edge/sync",
    "POST /edge/disconnect",
  ].map((s) => s.toUpperCase()),
);

/**
 * Routes that authenticate but intentionally have no permission check:
 * self-service (the caller only reaches their own records) or checks that
 * live inside the service call.
 */
export const SELF_SERVICE_REST_ROUTES: ReadonlySet<string> = new Set(
  [
    // current-user self service
    "GET /users/me",
    "PUT /users/me",
    "PUT /users/me/password",
    // token minting — membership/site access verified by the auth service
    "POST /auth/switch-workspace",
    "POST /auth/switch-site",
    // self-scoped listing (only the caller's own workspaces)
    "GET /workspaces",
    // membership-gated read of workspace metadata
    "GET /workspaces/:id",
    // in-service permission checks (invite.ts / members.ts enforce
    // user:write + owner escalation internally)
    "POST /users/invite",
    "PUT /workspaces/:id/members/:userId",
  ].map((s) => s.toUpperCase()),
);
