// Readiness check registry, served by GET /ready in api/index.ts.
// Same 200/503 semantics as @rw/runtime's http-host (/readyz), but served
// through Fastify since this app already has an HTTP server.
//
// /health stays a static liveness probe (fly healthchecks hit it) — only
// /ready reflects dependency state, and only `critical` checks flip it.

const CHECK_TIMEOUT_MS = 2000;

export type ReadinessCheck = () => Promise<boolean> | boolean;

type RegisteredCheck = {
  check: ReadinessCheck;
  critical: boolean;
};

export type CheckResult = {
  ok: boolean;
  critical: boolean;
  latencyMs: number;
  error?: string;
};

const checks = new Map<string, RegisteredCheck>();

export function registerReadinessCheck(name: string, check: ReadinessCheck, opts?: { critical?: boolean }): void {
  checks.set(name, { check, critical: opts?.critical ?? true });
}

export function unregisterReadinessCheck(name: string): void {
  checks.delete(name);
}

async function runOne(entry: RegisteredCheck): Promise<Omit<CheckResult, "critical">> {
  const startedAt = performance.now();
  try {
    const ok = await Promise.race([
      Promise.resolve(entry.check()),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`check timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS).unref();
      }),
    ]);
    return { ok, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runReadinessChecks(): Promise<{ ready: boolean; checks: Record<string, CheckResult> }> {
  const entries = [...checks.entries()];
  const results = await Promise.all(entries.map(([, entry]) => runOne(entry)));

  const report: Record<string, CheckResult> = {};
  let ready = true;
  entries.forEach(([name, entry], index) => {
    const result = results[index] as Omit<CheckResult, "critical">;
    report[name] = { ...result, critical: entry.critical };
    if (entry.critical && !result.ok) ready = false;
  });

  return { ready, checks: report };
}
