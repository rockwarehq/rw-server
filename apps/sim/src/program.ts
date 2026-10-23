// Pure simulation logic — no timers, no I/O. The runner asks "what does this
// station do next?": a cycle (its delay and the rate multiplier in force) or a
// stopped stretch to wait out.
//
// Rate multipliers act on RATE, not cycle time: 1.2 = 20% fast = standard
// cycle ÷ 1.2. Count-by-time machines report on a fixed interval, so for them
// the multiplier scales the count per report instead.

import type { AutoState, Step } from "./config.js";

export type Rng = () => number;

/** Mulberry32 — small seeded PRNG so each station's auto behavior differs but replays. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const between = (rng: Rng, min: number, max: number) => min + rng() * (max - min);

// ── Auto: a machine that sometimes runs great, slow, or stops ────────────────

interface AutoProfile {
  /** Rate multiplier range; [0, 0] = not cycling. */
  rate: [number, number];
  /** How long a stretch in this state lasts, seconds. */
  dwell: [number, number];
}

export const AUTO_PROFILES: Record<AutoState, AutoProfile> = {
  great: { rate: [1.05, 1.15], dwell: [10 * 60, 40 * 60] },
  normal: { rate: [0.95, 1.02], dwell: [30 * 60, 120 * 60] },
  slow: { rate: [0.7, 0.9], dwell: [5 * 60, 30 * 60] },
  microstop: { rate: [0, 0], dwell: [30, 3 * 60] },
  down: { rate: [0, 0], dwell: [10 * 60, 60 * 60] },
};

export const DEFAULT_AUTO_WEIGHTS: Record<AutoState, number> = {
  great: 15,
  normal: 55,
  slow: 15,
  microstop: 10,
  down: 5,
};

export interface AutoStretch {
  state: AutoState;
  /** Multiplier held for the whole stretch (0 when stopped). */
  rate: number;
  endsAt: number;
}

export function pickAutoStretch(
  weights: Partial<Record<AutoState, number>> | undefined,
  now: number,
  rng: Rng,
): AutoStretch {
  const w = { ...DEFAULT_AUTO_WEIGHTS, ...weights };
  const entries = (Object.keys(AUTO_PROFILES) as AutoState[]).map((s) => [s, Math.max(0, w[s] ?? 0)] as const);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  let roll = rng() * (total || 1);
  let state: AutoState = "normal";
  for (const [s, v] of entries) {
    if (roll < v) {
      state = s;
      break;
    }
    roll -= v;
  }
  const profile = AUTO_PROFILES[state];
  return {
    state,
    rate: between(rng, profile.rate[0], profile.rate[1]),
    endsAt: now + between(rng, profile.dwell[0], profile.dwell[1]) * 1000,
  };
}

// ── Program: steps that loop forever ─────────────────────────────────────────

export interface ProgramCursor {
  index: number;
  startedAt: number;
}

export function newCursor(now: number): ProgramCursor {
  return { index: 0, startedAt: now };
}

/** Advance past any steps whose time is up, wrapping to the first. */
export function advanceCursor(steps: Step[], cursor: ProgramCursor, now: number): ProgramCursor {
  let c = cursor;
  // Bounded: steps can't spin forever if the clock jumped far ahead.
  for (let guard = 0; guard <= steps.length; guard++) {
    const step = steps[c.index];
    if (!step || step.durationSec == null || now - c.startedAt < step.durationSec * 1000) return c;
    c = { index: (c.index + 1) % steps.length, startedAt: c.startedAt + step.durationSec * 1000 };
  }
  // Long gap (e.g. the process was paused): restart the current step from now.
  return { index: c.index, startedAt: now };
}

/** When the current step ends; null when it holds. */
export function stepEndsAt(step: Step, cursor: ProgramCursor): number | null {
  return step.durationSec != null ? cursor.startedAt + step.durationSec * 1000 : null;
}

// ── Turning a multiplier into a signal ───────────────────────────────────────

export type CycleModeValue = "DISCRETE" | "QUANTITY_PER_CYCLE" | "QUANTITY_PER_INTERVAL";

export interface Standards {
  mode: CycleModeValue;
  standardCycleSeconds: number;
  /** Expected count per report (count by time); null otherwise. */
  standardQuantity: number | null;
}

export interface CyclePlan {
  delayMs: number;
  /** Count to report with this signal (count by time only). */
  quantity: number | null;
}

/** ±jitter noise, so even ×1 doesn't look machine-perfect. */
export function noise(rng: Rng, jitter: number): number {
  return 1 + (rng() * 2 - 1) * Math.max(0, jitter);
}

export function planCycle(std: Standards, rate: number, jitter: number, rng: Rng): CyclePlan {
  const n = noise(rng, jitter);
  if (std.mode === "QUANTITY_PER_INTERVAL") {
    // Fixed report interval; the count carries the speed.
    const expected = std.standardQuantity ?? 1;
    return { delayMs: std.standardCycleSeconds * 1000, quantity: Math.max(0, Math.round(expected * rate * n)) };
  }
  return { delayMs: (std.standardCycleSeconds / rate) * n * 1000, quantity: null };
}
