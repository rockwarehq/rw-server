# 0010 – Livestore totalizer resolver on the shared fold engine

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** Michael St John

## Context

Users need running totals driven by live graph values — "totalWeight keeps accumulating `100 × weight`". The natural-looking way to express this is a self-referencing expression (`totalWeight = totalWeight + 100 * weight`), but the expr resolver is level-triggered and assumed idempotent: the engine freely re-evaluates expressions on boot (all computed properties are marked dirty), on definition changes, and via the reconcile loop. A self-referencing expression double-counts on every one of those re-evaluations, and a self-edge breaks the DAG contract (cycle detection, topo scheduling, and the commit→dirty loop).

A totalizer is not "a function of current values" — it is "accumulate once per event", which is edge-triggered and stateful. That is exactly the window resolver's shape: state folded synchronously per input commit, persisted in the `imm_agg_state` KV bucket, rehydrated across restarts. The livestore spec (§15) had explicitly deferred "counter with arbitrary reset" and "edge detection as a primitive"; this ADR picks that work up deliberately.

## Decision

We will implement totalizers as their own resolver type, served by the same fold engine as windows — not as self-referencing expressions.

- `{ type: "totalizer", sourcePropertyId, trigger, reset? }` — each trigger firing adds the source property's latest usable value to a persisted running total. The optional reset condition (same hook-condition shape as the trigger) zeroes total and count when it fires — e.g. `changed` on a businessShift property gives per-shift totals.
- Taxonomy and machinery are decoupled: `totalizer` is a first-class resolver type (own schema, own manifest entry, visible as a sibling of `window` in pickers), but the engine class (`FoldResolver`, formerly `WindowResolver`) serves both types with one copy of the shared machinery — input routing, synchronous per-commit folds, debounced/immediate KV persistence, rehydration, and per-runtime emit chains. No inheritance layer; only config parsing and fold dispatch branch by type.
- The trigger is mandatory and reuses the hook condition shape and evaluator (`{ source, operator, threshold?/value?/minDelta? }`) — exactly the existing hook operators, same semantics, same UI concept as graph hooks. No new operators are introduced. The trigger may target the source property itself (`changed`: "add each new weight value") or a separate property (PLC handshake bit via `crossesAbove`), so there is one config shape, not two totalizer flavors.
- Edge operators compare against the last **good** trigger sample stored in fold state (not the raw previous envelope), so a quality flap mid-high cannot fake or mask an edge. The reset condition follows the same rules — its own good-sample baseline (so a restart never causes a spurious reset) and its own replay guard (a re-delivered old shift value must not spuriously reset).
- Trigger samples at or before the last folded trigger timestamp are dropped (replay/out-of-order guard) — a re-delivered edge must not double-add.
- When one commit plays several roles (shared input properties), reset applies first — the boundary starts the new period and the same commit's add counts toward it — then source folds before trigger.
- The running total survives restarts and config edits: rewiring the source, trigger, or reset resets only the per-input tracking fields, never the total. Expressions stay upstream — the per-sample math (`100 × weight`) lives in an ordinary expr property that the totalizer sources.
- The kernel is untouched. Both trigger and source become ordinary `GraphEdge` rows via the resolver's `dependencyIds`, so cycle detection, topo scheduling, and hot-reload work unchanged.
- The window-over-window ban (§17.10) generalizes to a stateful-chain ban over `{window, totalizer}`: neither resolver may source (or trigger off) another stateful resolver, because a stateful input compounds restart/catch-up artifacts into downstream state.

## Consequences

- Expressions remain pure and idempotent; nothing in the engine ever re-evaluates an accumulating computation.
- Totalizer adds persist to KV immediately (not debounced) since they are low-rate, business-critical mutations; source tracking updates stay on the 500ms debounce.
- Without an "every sample" operator, two identical consecutive values on a `changed` trigger count once — that information isn't in a value stream. Sources that can repeat values need a distinct trigger (cycle counter, handshake bit). An `everySample` operator can be added to the shared set later if a real case demands it.
- Property-driven resets cover the periodic cases (per-shift/day via a boundary property). A **manual** reset ("zero this now" from the console) still needs an API→engine command path; deferred as a follow-up. The last emit before a reset is the period's final value — archiving per-period totals is the rollup/metrics pipeline's job, not the totalizer's.
- The trigger-fires-before-source race (PLC writes weight and raises the bit in the same scan, messages arrive reordered) is a PLC-side handshake concern; we document it rather than engineer around it.

## Alternatives Considered

- **Self-referencing expressions** — non-idempotent evaluation corrupts the total on every boot/reconcile/definition-change re-evaluation, and a self-edge breaks cycle detection and the dirty-propagation loop. Rejected.
- **Totalizer as a third `window` kind** — reuses the machinery without a new resolver type, but a totalizer is unbounded where windows are time-bounded; hiding it as a window kind misnames the concept everywhere users see it. Rejected in favor of a first-class type on the shared engine (the initial implementation used this shape and was refactored before merge).
- **Distinct resolver class with an extracted base abstraction** — an inheritance/framework layer for exactly two consumers; the shared engine gets the same reuse with less indirection. Rejected.
- **Bespoke trigger-mode enum (`rising-edge` / `on-change` / …)** — a second trigger vocabulary to learn and validate when hook conditions already express the same semantics. Rejected in favor of reusing hook conditions.
