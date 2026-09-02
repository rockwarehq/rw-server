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

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function isOptionalCause(value: unknown): value is EventCause | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<EventCause>;
  return typeof c.correlationId === "string" && typeof c.causationId === "string" && typeof c.hop === "number";
}
