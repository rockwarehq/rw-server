// Client for rw-hub, the shared cloud service that holds the Twilio credentials and receives
// the webhooks an on-prem tenant cannot. Outbound HTTPS only; results come back via readEvents().

const hubConfig = {
  baseUrl: (process.env.HUB_URL || "").replace(/\/+$/, ""),
  apiKey: process.env.HUB_API_KEY || "",
};

export function isHubEnabled(): boolean {
  return !!(hubConfig.baseUrl && hubConfig.apiKey);
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** Never throws: every failure is a Result, so a caller always has something to record. */
async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Result<T>> {
  if (!isHubEnabled()) return { ok: false, error: "hub disabled (HUB_URL / HUB_API_KEY unset)" };

  try {
    const response = await fetch(`${hubConfig.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${hubConfig.apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    if (!response.ok) {
      return {
        ok: false,
        error: String(payload?.error ?? `hub responded ${response.status}`),
        code: payload?.code ? String(payload.code) : undefined,
      };
    }
    return { ok: true, data: payload as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── sending ─────────────────────────────────────────────────────────────────

/** BLOCKED = the hub refused (no consent, over cap); the message never reached a carrier. */
type HubSendStatus = "QUEUED" | "SENT" | "DELIVERED" | "UNDELIVERED" | "BLOCKED" | "FAILED";

export type SendSmsResult = { ok: true; sid: string } | { ok: false; error: string };

/** A hub BLOCKED/FAILED is an error here so the delivery row records what actually happened. */
export async function sendSms(params: { to: string; body: string }): Promise<SendSmsResult> {
  const result = await request<{ id: string; status: HubSendStatus; error: string | null }>("POST", "/v1/sms", params);
  if (!result.ok) return { ok: false, error: result.error };

  const { id, status, error } = result.data;
  const delivered = status !== "BLOCKED" && status !== "FAILED" && status !== "UNDELIVERED";
  return delivered ? { ok: true, sid: id } : { ok: false, error: error ?? `hub returned ${status}` };
}

// ── consent ─────────────────────────────────────────────────────────────────

export type ConsentStatus = "OPTED_IN" | "OPTED_OUT";
export type ConsentMethod = "WEB_FORM" | "VERBAL" | "PAPER" | "TEXT_KEYWORD" | "STOP_KEYWORD" | "IMPORTED";

export interface HubConsent {
  phone: string;
  status: ConsentStatus;
  method: ConsentMethod;
  statusAt: string;
  carrierStopAt: string | null;
}

export interface RecordConsentParams {
  phone: string;
  status: ConsentStatus;
  method: ConsentMethod;
  /** Our user id, opaque to the hub. */
  actorRef?: string;
  note?: string;
  decidedAt?: string;
}

/** The hub is the gate: this must succeed before a local row is written. */
export function recordConsent(params: RecordConsentParams): Promise<Result<HubConsent>> {
  return request<HubConsent>("POST", "/v1/sms/consent", params);
}

// ── down-channel ────────────────────────────────────────────────────────────

export interface HubEvent {
  id: string;
  type: "sms.consent.changed" | "sms.message.status";
  payload: Record<string, unknown>;
  occurredAt: string;
}

/** Cursor is an opaque string: the hub's id is a bigint and does not survive as a number. */
export function readEvents(since: string, limit = 100): Promise<Result<{ events: HubEvent[]; cursor: string }>> {
  return request<{ events: HubEvent[]; cursor: string }>("GET", `/v1/events?since=${since}&limit=${limit}`);
}
