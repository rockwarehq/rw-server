# 0009 – Outbound Integrations and Hook Trigger Binding

- **Status:** Accepted
- **Date:** 2026-08-03
- **Deciders:** Michael St John

## Context

Customers need LiveStore hook events to cause side effects outside our stack — the driving case is
executing a stored procedure on a plant SQL Server when a cycle completes, with REST calls and
webhooks close behind. Three constraints shaped the design:

- `docs/architecture/livestore-spec.md` §4.8 declares hooks **terminal event emitters**: a hook decides that
  something happened and publishes it; it does not execute actions.
- Credentials (SQL passwords, API keys) must be stored recoverably — they are presented to external
  systems, so the one-way hashing in `@rw/auth` cannot be used.
- The repo already had three disconnected action registries (station actions, `@rw/automations`,
  and the hook event catalog); a fourth ad-hoc one would compound the drift.

We evaluated adopting Activepieces rather than building: its MIT core has no MSSQL piece, no
standalone action-execution SDK, and no on-prem gateway story, while its multi-tenant embed
scenario requires a commercial license. We took its *design* (piece/connection split, `PieceAuth`
shapes, env-key-encrypted connection store) and built `@rw/integrations`.

## Decision

We will keep hooks terminal and introduce three separated layers:

1. **Integration** (`Integration` row + `@rw/integrations` type registry) — a configured outbound
   target. Each type declares two zod schemas: `configSchema` (plaintext: host, port, username;
   safe to read and log) and `secretSchema` (encrypted at rest). The split makes redaction
   structural — the service layer's `publicSelect` never includes ciphertext — and lets the console
   render forms from serialized JSON Schema without per-type UI.
2. **Action** — versioned capability contracts (`latest` + `versions`, the `@rw/automations`
   schema pattern) with an in-process `run`. Everything executes in rw-server (`execution:
   "server"`): on-prem deployments put rw-server on the plant network, so no gateway dispatch is
   needed. `"edge"` is reserved but unused.
3. **Binding** (`IntegrationTrigger` row) — maps an emitted LiveStore event (optionally one hook)
   to an integration action. Action inputs are literal JSON templates with `{ "$from": "field" }`
   nodes resolved against the event payload — **structured references, not string interpolation** —
   so values keep their types, a present-null is distinct from absent, and a missing field fails
   loudly instead of rendering `""`. Templates are validated at save time against the fields
   matching hooks actually emit.

Secrets are sealed with AES-256-GCM (`[version][iv][tag][ciphertext]`, integration id bound as
AAD) under `INTEGRATION_ENCRYPTION_KEY`, held only in the environment (fly secret / provisioner
`state.json`) and never in Postgres. The key must be backed up with the database;
`INTEGRATION_ENCRYPTION_KEY_PREVIOUS` supports rotation. Only api and workers hold the key;
livestore never touches ciphertext.

Hooks gain **opt-in dynamic context**: an event schema may declare `dynamicContext`, letting a hook
bind context fields the catalog does not declare (author-supplied `valueType`, default required).
Only `livestore.hook_triggered@1` opts in; `imm.cycle_completed` stays fixed because the imm-events
worker depends on its shape.

Execution is recorded in `IntegrationRun` (status, input, result/error, duration) with a unique
`dedupeKey` (`eventId:triggerId`) turning at-least-once redelivery into detectable duplicates. The
`integration-events` worker consumes `livestore.events.>` on a durable JetStream consumer; action
failures become `FAILED` runs and are acked — never nak-looped.

This package is the target registry: station actions and `@rw/automations` actions should migrate
into it and gain no new entries.

## Consequences

- A second consumer (automations, manual runs, the `integration.execute` RPC) reuses integrations
  with no new wiring; nothing about hooks changed shape on the wire.
- Adding an integration type is one server-side file plus a `.register()` call; the console renders
  it from the catalog.
- The encryption key is operationally load-bearing: lost key = unrecoverable credentials; deploys
  fail fast via `required_secrets` until it is set per tenant.
- Deleting a hook pinned by an enabled trigger is refused (`HOOK_HAS_TRIGGERS`); editing a hook's
  context fields is not revalidated against triggers — a stranded `$from` surfaces as a `FAILED`
  run at fire time, accepted for now.
- Trigger matching queries Postgres per event (no cache), so trigger edits take effect immediately;
  caching is a known optimization if a high-frequency path appears.

## Alternatives Considered

- **Action reference on `GraphHook`** — violates the terminal-hook invariant and couples every
  future consumer to hook schema changes.
- **Adopt Activepieces / embedded iPaaS** — no MSSQL piece, no standalone execution SDK, commercial
  license for the multi-tenant scenario; the differentiated 80% (graph binding, on-prem reach,
  quality gating) would still be ours to build.
- **`{{token}}` string interpolation** (the `@rw/automations` pattern) — stringifies values, turns
  null into `""`, and resolves typos to empty strings; unacceptable for stored-procedure parameters.
- **Hash-based secret storage** — one-way; the plaintext must reach SQL Server.
- **External secret manager (Vault etc.)** — an unseal/availability dependency on plant-floor
  installs with no ops staff; revisit if rotation-as-a-service becomes a requirement.
- **Extending `@rw/automations` in place** — its global (workspace-unscoped) model contradicts
  site-scoped credentials; its schema patterns were adopted, its engine was not.
