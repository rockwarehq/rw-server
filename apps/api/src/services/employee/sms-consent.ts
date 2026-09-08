import prisma from "@rw/db";
import type { SmsConsentMethod, SmsConsentStatus } from "@rw/db";
import { listConsentHistory, recordConsent } from "@rw/services/notification/consent";

// Consent is stored per phone number; these resolve the employee's current number and hand off.

type ServiceError = { error: string; code: string };

async function phoneOf(employeeId: string): Promise<ServiceError | { workspaceId: string; phone: string }> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { workspaceId: true, version: { select: { phone: true } } },
  });
  if (!employee) return { error: "Employee not found", code: "NOT_FOUND" };
  const phone = employee.version?.phone;
  if (!phone) return { error: "Employee has no phone number", code: "NO_PHONE" };
  return { workspaceId: employee.workspaceId, phone };
}

export interface SetSmsConsentInput {
  employeeId: string;
  status: SmsConsentStatus;
  method: SmsConsentMethod;
  note?: string | null;
  /** The signed-in user recording it. */
  actorUserId?: string | null;
}

export async function set(input: SetSmsConsentInput) {
  const resolved = await phoneOf(input.employeeId);
  if ("error" in resolved) return resolved;
  const consent = await recordConsent({ ...resolved, ...input });
  if ("error" in consent) return consent;
  return { data: consent };
}

/** Every decision recorded for this employee's current number, newest first. */
export async function history(employeeId: string) {
  const resolved = await phoneOf(employeeId);
  if ("error" in resolved) return resolved;
  return { data: await listConsentHistory(resolved.workspaceId, resolved.phone) };
}
