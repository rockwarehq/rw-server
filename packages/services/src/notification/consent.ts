import prisma from "@rw/db";
import type { ActionSource, SmsConsent, SmsConsentMethod, SmsConsentStatus } from "@rw/db";
import * as hub from "@rw/runtime/hub";
import { toE164 } from "@rw/runtime/phone";

// SMS consent, keyed by phone number: a STOP identifies a number, not a person, and a number
// can move between employee records. No row means nobody ever asked, which is not OPTED_OUT.
//
// rw-hub holds the global list the carriers enforce against. This is a per-workspace replica,
// written after the hub agrees (recordConsent) or when the hub reports a change (applyFromHub).

export interface RecordConsentInput {
  workspaceId: string;
  phone: string;
  status: SmsConsentStatus;
  method: SmsConsentMethod;
  /** MANUAL = recorded by a person in the app (default); SYSTEM = the carrier told us. */
  source?: ActionSource;
  actorUserId?: string | null;
  note?: string | null;
  /** When the decision was made, if not now (an import, a backdated paper form). */
  decidedAt?: Date;
  /** Set only by applyFromHub, to make replay idempotent. */
  relayEventId?: string | null;
}

type ServiceError = { error: string; code: string };

/** State and its history entry are written together, so one never exists without the other. */
async function writeLocal(input: RecordConsentInput): Promise<SmsConsent> {
  const phone = toE164(input.phone);
  const statusAt = input.decidedAt ?? new Date();
  const state = { status: input.status, method: input.method, statusAt };

  return prisma.$transaction(async (tx) => {
    const consent = await tx.smsConsent.upsert({
      where: { workspaceId_phone: { workspaceId: input.workspaceId, phone } },
      create: { workspaceId: input.workspaceId, phone, ...state },
      update: state,
    });
    await tx.smsConsentEvent.create({
      data: {
        consentId: consent.id,
        status: input.status,
        method: input.method,
        source: input.source ?? "MANUAL",
        actorUserId: input.actorUserId ?? null,
        note: input.note ?? null,
        relayEventId: input.relayEventId ?? null,
        createdAt: statusAt,
      },
    });
    return consent;
  });
}

/**
 * A decision made by a person in this app. The hub is asked first and the local row written
 * only if it agrees; otherwise this workspace would show OPTED_IN for a number every send refuses.
 */
export async function recordConsent(input: RecordConsentInput): Promise<ServiceError | SmsConsent> {
  // No hub means no SMS at all, so there is no gate to satisfy and nothing to diverge from.
  if (!hub.isHubEnabled()) return writeLocal(input);

  const result = await hub.recordConsent({
    phone: toE164(input.phone),
    status: input.status,
    method: input.method,
    actorRef: input.actorUserId ?? undefined,
    note: input.note ?? undefined,
    decidedAt: input.decidedAt?.toISOString(),
  });
  // CARRIER_STOP passes through: the person texted STOP and only they can undo it.
  if (!result.ok) return { error: result.error, code: result.code ?? "HUB_UNAVAILABLE" };
  return writeLocal(input);
}

/** A change the hub reported (carrier STOP, another workspace's decision). Never calls the hub back. */
export function applyFromHub(input: RecordConsentInput & { relayEventId: string }): Promise<SmsConsent> {
  return writeLocal({ ...input, source: "SYSTEM" });
}

/** Current consent for one number, or null when nobody ever asked. */
export async function getConsent(workspaceId: string, phone: string) {
  return prisma.smsConsent.findUnique({
    where: { workspaceId_phone: { workspaceId, phone: toE164(phone) } },
  });
}

/** Every decision ever recorded for a number, newest first. */
export async function listConsentHistory(workspaceId: string, phone: string) {
  const consent = await prisma.smsConsent.findUnique({
    where: { workspaceId_phone: { workspaceId, phone: toE164(phone) } },
    include: { events: { orderBy: { createdAt: "desc" } } },
  });
  return consent?.events ?? [];
}

export interface ConsentState {
  status: SmsConsentStatus;
  method: SmsConsentMethod;
  statusAt: Date;
}

/** Bulk lookup: normalized number → current consent. A missing number was never asked. */
export async function consentByPhone(
  workspaceId: string,
  phones: Array<string | null | undefined>,
): Promise<Map<string, ConsentState>> {
  const wanted = [...new Set(phones.filter((p): p is string => !!p).map(toE164))];
  if (wanted.length === 0) return new Map();
  const rows = await prisma.smsConsent.findMany({
    where: { workspaceId, phone: { in: wanted } },
    select: { phone: true, status: true, method: true, statusAt: true },
  });
  return new Map(rows.map(({ phone, ...state }) => [phone, state]));
}

/** Workspaces holding a row for this number: who a hub event has to be applied to. */
export async function workspacesForPhone(phone: string): Promise<string[]> {
  const rows = await prisma.smsConsent.findMany({
    where: { phone: toE164(phone) },
    select: { workspaceId: true },
    distinct: ["workspaceId"],
  });
  return rows.map((r) => r.workspaceId);
}
