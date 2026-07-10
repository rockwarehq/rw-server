// Postgres timeout classifier — lifted from rw-server/src/database/timeouts.ts.
//
// When statement_timeout / lock_timeout / idle_in_transaction_session_timeout
// fire, Postgres returns specific SQLSTATEs that Prisma surfaces in the error
// object. classifyDbTimeout(err) detects these so callers can log them with a
// distinct, greppable prefix instead of leaving them buried in a stack trace.

export type DbTimeoutKind = "statement_timeout" | "lock_timeout" | "idle_in_transaction_session_timeout";

const SQLSTATE_TO_KIND: Record<string, DbTimeoutKind> = {
  "57014": "statement_timeout",
  "55P03": "lock_timeout",
  "25P03": "idle_in_transaction_session_timeout",
};

const MESSAGE_FRAGMENT_TO_KIND: Array<[RegExp, DbTimeoutKind]> = [
  [/canceling statement due to statement timeout/i, "statement_timeout"],
  [/canceling statement due to lock timeout/i, "lock_timeout"],
  [/idle[- ]in[- ]transaction/i, "idle_in_transaction_session_timeout"],
];

export function classifyDbTimeout(err: unknown): DbTimeoutKind | null {
  if (!err || typeof err !== "object") return null;

  const version = serializeForMatching(err);

  for (const [code, kind] of Object.entries(SQLSTATE_TO_KIND)) {
    if (version.includes(code)) return kind;
  }
  for (const [pattern, kind] of MESSAGE_FRAGMENT_TO_KIND) {
    if (pattern.test(version)) return kind;
  }
  return null;
}

function serializeForMatching(err: object): string {
  try {
    return JSON.stringify(err, Object.getOwnPropertyNames(err));
  } catch {
    return String((err as { message?: unknown }).message ?? err);
  }
}
