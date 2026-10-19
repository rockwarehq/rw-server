// Sign-in for the simulator UI, against the platform API (SIM_API_URL): the
// same /auth/login rw-imm uses. Tokens live in httpOnly cookies on the
// simulator's own origin; each access token is checked with the API
// (GET /users/me) and cached briefly, so the simulator holds no JWT secret
// and revoked sessions stop working. Expired access tokens refresh from the
// refresh cookie transparently.

import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const ACCESS_COOKIE = "sim_at";
const REFRESH_COOKIE = "sim_rt";
const ACCESS_MAX_AGE_S = 15 * 60;
const REFRESH_MAX_AGE_S = 7 * 24 * 60 * 60;
/** How long a verified access token is trusted before asking the API again. */
const VERIFY_TTL_MS = 30_000;

export interface SimUser {
  id: string;
  email: string;
  name: string | null;
  workspaceId: string | null;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Claims are read only after the API has verified the token. */
function claims(token: string): { id?: string; email?: string; workspaceId?: string; exp?: number } {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function readCookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(req: FastifyRequest, name: string, value: string, maxAge: number): string {
  // Fly terminates TLS, so trust the forwarded proto for Secure.
  const secure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export class SimAuth {
  private verified = new Map<string, { user: SimUser; until: number }>();
  private refreshing = new Map<string, Promise<TokenPair | null>>();

  constructor(
    private readonly apiUrl: string,
    /** Workspaces whose users may sign in; empty = any signed-in user. */
    private readonly allowedWorkspaces: () => Set<string>,
  ) {}

  async login(req: FastifyRequest, reply: FastifyReply, email: string, password: string): Promise<SimUser | null> {
    const res = await this.call("/auth/login", { email, password });
    if (!res) return null;
    const pair = res as TokenPair;
    const user = await this.verify(pair.accessToken);
    if (!user || !this.allowed(user)) return null;
    this.setTokens(req, reply, pair);
    return user;
  }

  async logout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const rt = readCookies(req)[REFRESH_COOKIE];
    if (rt) await this.call("/auth/logout", { refreshToken: rt }).catch(() => null);
    reply.header("set-cookie", [cookie(req, ACCESS_COOKIE, "", 0), cookie(req, REFRESH_COOKIE, "", 0)]);
  }

  /** The signed-in user, refreshing the access token when it has expired; null = not signed in. */
  async authenticate(req: FastifyRequest, reply: FastifyReply): Promise<SimUser | null> {
    const cookies = readCookies(req);
    const at = cookies[ACCESS_COOKIE];
    if (at) {
      const user = await this.verify(at);
      if (user) return this.allowed(user) ? user : null;
    }
    const rt = cookies[REFRESH_COOKIE];
    if (!rt) return null;
    const pair = await this.refresh(rt);
    if (!pair) return null;
    const user = await this.verify(pair.accessToken);
    if (!user || !this.allowed(user)) return null;
    this.setTokens(req, reply, pair);
    return user;
  }

  private allowed(user: SimUser): boolean {
    const workspaces = this.allowedWorkspaces();
    return workspaces.size === 0 || (user.workspaceId != null && workspaces.has(user.workspaceId));
  }

  private setTokens(req: FastifyRequest, reply: FastifyReply, pair: TokenPair): void {
    reply.header("set-cookie", [
      cookie(req, ACCESS_COOKIE, pair.accessToken, ACCESS_MAX_AGE_S),
      cookie(req, REFRESH_COOKIE, pair.refreshToken, REFRESH_MAX_AGE_S),
    ]);
  }

  private async verify(accessToken: string): Promise<SimUser | null> {
    const key = hash(accessToken);
    const now = Date.now();
    const hit = this.verified.get(key);
    if (hit && hit.until > now) return hit.user;
    this.verified.delete(key);

    const res = await fetch(`${this.apiUrl}/users/me`, { headers: { authorization: `Bearer ${accessToken}` } }).catch(
      () => null,
    );
    if (!res?.ok) return null;
    const me = (await res.json().catch(() => ({}))) as {
      user?: { id?: string; email?: string; firstName?: string | null; lastName?: string | null };
      workspace?: { id?: string } | null;
    };
    const c = claims(accessToken);
    const user: SimUser = {
      id: me.user?.id ?? c.id ?? "",
      email: me.user?.email ?? c.email ?? "",
      name: [me.user?.firstName, me.user?.lastName].filter(Boolean).join(" ") || null,
      workspaceId: me.workspace?.id ?? c.workspaceId ?? null,
    };
    const expMs = c.exp ? c.exp * 1000 : now + VERIFY_TTL_MS;
    this.verified.set(key, { user, until: Math.min(now + VERIFY_TTL_MS, expMs) });
    if (this.verified.size > 500) this.verified.delete(this.verified.keys().next().value as string);
    return user;
  }

  // The UI polls every 2s, so several requests can hit an expired token at
  // once; share one refresh per refresh token (refresh tokens rotate).
  private refresh(refreshToken: string): Promise<TokenPair | null> {
    let pending = this.refreshing.get(refreshToken);
    if (!pending) {
      pending = this.call("/auth/refresh", { refreshToken })
        .then((r) => (r as TokenPair | null) ?? null)
        .finally(() => setTimeout(() => this.refreshing.delete(refreshToken), 5_000));
      this.refreshing.set(refreshToken, pending);
    }
    return pending;
  }

  private async call(path: string, body: unknown): Promise<unknown | null> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) return null;
    return res.json().catch(() => null);
  }
}
