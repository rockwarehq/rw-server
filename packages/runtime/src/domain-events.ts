// Helpers shared by the domain event contracts (call-events, mode-events, ...). Dependency-free.

/** The automation event that caused a domain change, carried onto the change's outbound event so the chain stays traceable. */
export interface EventCause {
  correlationId: string;
  causationId: string;
  hop: number;
}

/** Make a value safe as one NATS subject token: no wildcards, no whitespace, path separators become dots. */
export function sanitizeSubjectToken(value: string): string {
  const token = value.trim().replaceAll("/", ".").replaceAll("\\", ".").replace(/\s+/g, "_");
  return token
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/[*>]/g, "_"))
    .join(".");
}

/**
 * Where a shop-floor change happened, snapshotted at the moment of the change so a consumer can
 * react (or an automation can match) without a DB read. All optional: a station may have no work
 * center, no current job, or no shift running.
 */
export interface WorkContext {
  workcenterId?: string;
  workcenterName?: string;
  jobId?: string;
  jobName?: string;
  shiftInstanceId?: string;
  /** e.g. "Shift 1" */
  shiftName?: string;
  /** YYYY-MM-DD of the business day the change belongs to. */
  businessDate?: string;
}

export const WORK_CONTEXT_KEYS = [
  "workcenterId",
  "workcenterName",
  "jobId",
  "jobName",
  "shiftInstanceId",
  "shiftName",
  "businessDate",
] as const satisfies ReadonlyArray<keyof WorkContext>;

export function isOptionalWorkContext(value: object): boolean {
  return WORK_CONTEXT_KEYS.every((key) => isOptionalString((value as Record<string, unknown>)[key]));
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function isOptionalCause(value: unknown): value is EventCause | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<EventCause>;
  return typeof c.correlationId === "string" && typeof c.causationId === "string" && typeof c.hop === "number";
}
